import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createA2aClient } from '../src/client.js';
import { A2aError } from '../src/errors.js';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

type Handler = (body: { id: string; method: string }, res: ServerResponse, req: IncomingMessage) => void;

async function fake(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => handler(JSON.parse(raw) as { id: string; method: string }, res, req));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/a2a`;
}

const json = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const TASK = { id: 't-1', contextId: 'c-1', status: { state: 'TASK_STATE_WORKING' } };

describe('createA2aClient', () => {
  it('https olmayan uç noktayı izin verilmedikçe reddeder', () => {
    expect(() => createA2aClient({ url: 'http://agent.example/a2a', timeoutMs: 1000 })).toThrow(/https/);
    expect(() =>
      createA2aClient({ url: 'ftp://agent.example/a2a', timeoutMs: 1000, allowInsecureHttp: true }),
    ).toThrow();
    expect(() => createA2aClient({ url: 'https://agent.example/a2a', timeoutMs: 1000 })).not.toThrow();
  });

  it('sürüm başlığını ve çağıranın başlıklarını gönderir', async () => {
    let seen: IncomingMessage['headers'] = {};
    const url = await fake((body, res, req) => {
      seen = req.headers;
      json(res, { jsonrpc: '2.0', id: body.id, result: TASK });
    });
    const client = createA2aClient({
      url,
      timeoutMs: 2000,
      allowInsecureHttp: true,
      headers: async () => ({ 'x-api-key': 'k' }),
    });
    expect((await client.getTask({ id: 't-1' })).id).toBe('t-1');
    expect(seen['a2a-version']).toBe('1.0');
    expect(seen['x-api-key']).toBe('k');
  });

  it('JSON-RPC hatasını A2aError olarak fırlatır', async () => {
    const url = await fake((body, res) =>
      json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Task not found', data: [] } }),
    );
    await expect(
      createA2aClient({ url, timeoutMs: 2000, allowInsecureHttp: true }).getTask({ id: 'x' }),
    ).rejects.toMatchObject({
      code: -32001,
    });
  });

  it('kimliği eşleşmeyen, şemaya uymayan, JSON olmayan ve büyük yanıtları reddeder', async () => {
    let mode = 'id';
    const url = await fake((body, res) => {
      if (mode === 'id') return json(res, { jsonrpc: '2.0', id: 'başka', result: TASK });
      if (mode === 'schema') return json(res, { jsonrpc: '2.0', id: body.id, result: { id: '' } });
      if (mode === 'text') {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end('<html>');
      }
      return json(res, { jsonrpc: '2.0', id: body.id, result: { ...TASK, metadata: { blob: 'x'.repeat(4096) } } });
    });
    const client = createA2aClient({ url, timeoutMs: 2000, allowInsecureHttp: true, maxResponseBytes: 1024 });
    for (const m of ['id', 'schema', 'text', 'big']) {
      mode = m;
      const error = await client.getTask({ id: 't-1' }).catch((e: unknown) => e);
      expect(error, m).toBeInstanceOf(A2aError);
      expect((error as A2aError).code, m).toBe(-32006);
    }
  });

  it('akış beklenirken JSON hata yanıtı gelirse hatayı fırlatır', async () => {
    const url = await fake((body, res) =>
      json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32004, message: 'This operation is not supported' } }),
    );
    const client = createA2aClient({ url, timeoutMs: 2000, allowInsecureHttp: true });
    await expect(
      (async () => {
        for await (const event of client.subscribeToTask({ id: 't-1' })) void event;
      })(),
    ).rejects.toMatchObject({ code: -32004 });
  });

  it('başarılı yanıtta kimlik null olamaz; hata mesajı kısaltılır, geçersiz ayrıntılar atılır', async () => {
    let mode = 'null-id';
    const url = await fake((body, res) => {
      if (mode === 'null-id') return json(res, { jsonrpc: '2.0', id: null, result: TASK });
      return json(res, {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32001, message: 'x'.repeat(5000), data: [null, 5, { '@type': 'tip' }] },
      });
    });
    const client = createA2aClient({ url, timeoutMs: 2000, allowInsecureHttp: true });
    await expect(client.getTask({ id: 't-1' })).rejects.toMatchObject({ code: -32006 });
    mode = 'error';
    const error = (await client.getTask({ id: 't-1' }).catch((e: unknown) => e)) as A2aError;
    expect(error.code).toBe(-32001);
    expect(error.message.length).toBeLessThanOrEqual(1024);
    expect(error.data).toEqual([{ '@type': 'tip' }]);
  });

  it('yavaş tüketici akışı zaman aşımına düşürmez; yalnız CR satır sonları da olay ayırır', async () => {
    const url = await fake((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (n: number) =>
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: { ...TASK, id: `t-${n}` } } })}\r\r`;
      res.write(event(1));
      setTimeout(() => res.write(': ping\r\r'), 100);
      setTimeout(() => res.end(event(2)), 150);
    });
    const client = createA2aClient({ url, timeoutMs: 250, allowInsecureHttp: true });
    const ids: string[] = [];
    for await (const event of client.subscribeToTask({ id: 't-1' })) {
      ids.push(event.task!.id);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    expect(ids).toEqual(['t-1', 't-2']);
  });

  it('CRLF bölünse de olay doğru ayrılır', async () => {
    const url = await fake((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: TASK } })}\r\n\r\n`;
      const cut = frame.length - 3;
      res.write(frame.slice(0, cut));
      setTimeout(() => res.end(frame.slice(cut)), 30);
    });
    const client = createA2aClient({ url, timeoutMs: 2000, allowInsecureHttp: true });
    const seen: unknown[] = [];
    for await (const event of client.subscribeToTask({ id: 't-1' })) seen.push(event);
    expect(seen).toEqual([{ task: TASK }]);
  });

  it('akışta CRLF satır sonlarını ve yorum satırlarını işler; olaylar arası süre dolunca keser', async () => {
    const url = await fake((body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `: ping\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { task: TASK } })}\r\n\r\n`,
      );
    });
    const client = createA2aClient({ url, timeoutMs: 300, allowInsecureHttp: true });
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of client.subscribeToTask({ id: 't-1' })) seen.push(event);
      })(),
    ).rejects.toThrow();
    expect(seen).toEqual([{ task: TASK }]);
  });
});
