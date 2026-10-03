import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { openSse, type SseOptions, type SseStream } from '../src/sse.js';

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(options: SseOptions, onOpen: (stream: SseStream) => void): Promise<number> {
  server = createServer((_req, res) => onOpen(openSse(res, options)));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function connect(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/' }, resolve).on('error', reject).end();
  });
}

const OPTIONS: SseOptions = { heartbeatMs: 20, maxDurationMs: 5_000, maxBufferedBytes: 1024 * 1024 };

describe('openSse', () => {
  it('başlıklar, data satırları ve kalp atışı', async () => {
    let stream!: SseStream;
    const port = await serve(OPTIONS, (s) => {
      stream = s;
      s.send({ a: 1 });
    });
    const response = await connect(port);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-cache, no-transform');
    let text = '';
    await new Promise<void>((resolve) => {
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes(': ping')) resolve();
      });
    });
    expect(text.startsWith('data: {"a":1}\n\n')).toBe(true);
    stream.close();
    expect(stream.isClosed()).toBe(true);
    expect(stream.send({ b: 2 })).toBe(false);
    await stream.closed;
  });

  it('azami süre dolunca akış kapanır', async () => {
    let stream!: SseStream;
    const port = await serve({ ...OPTIONS, maxDurationMs: 50 }, (s) => {
      stream = s;
    });
    const response = await connect(port);
    response.resume();
    await new Promise<void>((resolve) => response.on('end', () => resolve()));
    await stream.closed;
    expect(stream.isClosed()).toBe(true);
  });

  it('istemci bağlantıyı kapatınca akış kapanır', async () => {
    let stream!: SseStream;
    const port = await serve(OPTIONS, (s) => {
      stream = s;
    });
    const response = await connect(port);
    response.destroy();
    await stream.closed;
    expect(stream.isClosed()).toBe(true);
  });

  it('yavaş tüketicide tampon sınırı aşılınca akış kapanır', async () => {
    let stream!: SseStream;
    const port = await serve({ ...OPTIONS, heartbeatMs: 60_000, maxBufferedBytes: 64 * 1024 }, (s) => {
      stream = s;
    });
    const response = await connect(port);
    response.pause();
    const payload = { blob: 'x'.repeat(64 * 1024) };
    let accepted = 0;
    while (stream.send(payload) && accepted < 10_000) accepted += 1;
    expect(stream.isClosed()).toBe(true);
    expect(accepted).toBeLessThan(10_000);
    response.destroy();
  });
});
