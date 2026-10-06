import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Connection } from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createFailoverFetch, type FailoverReason } from '../src/rpc-failover.js';

type Behavior = 'ok' | '503' | '429' | 'hang' | 'rpc-error';
const servers: Server[] = [];

/** Davranışı değiştirilebilen yerel JSON-RPC sunucusu; gelen istekleri sayar. */
async function rpcServer(initial: Behavior) {
  const state = { behavior: initial, hits: 0 };
  const server = createServer((req, res) => {
    state.hits += 1;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const id = body ? (JSON.parse(body) as { id: unknown }).id : null;
      if (state.behavior === 'hang') return;
      if (state.behavior === '503') return void res.writeHead(503).end('unavailable');
      if (state.behavior === '429') return void res.writeHead(429).end('slow down');
      res.setHeader('content-type', 'application/json');
      if (state.behavior === 'rpc-error') {
        return void res.end(
          JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }),
        );
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { 'solana-core': '4.1.2', 'feature-set': 1 } }));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

afterAll(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
});

const rpc = (url: string, id = 1) =>
  ({
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'getVersion' }),
    },
  }) as const;

describe('createFailoverFetch', () => {
  it('düşen uçtan sıradakine geçer, tercih edilen ucu hatırlar ve web3.js Connection ile çalışır', async () => {
    const a = await rpcServer('503');
    const b = await rpcServer('ok');
    const events: FailoverReason[] = [];
    let now = 0;
    const failover = createFailoverFetch({
      endpoints: [a.url, b.url],
      timeoutMs: 2000,
      cooldownMs: 30_000,
      clock: () => now,
      onFailover: (event) => events.push(event.reason),
    });
    const connection = new Connection(a.url, { fetch: failover, commitment: 'confirmed' });
    expect(await connection.getVersion()).toMatchObject({ 'solana-core': '4.1.2' });
    expect(events).toEqual(['server_error']);
    expect(failover.endpoint()).toBe(`${b.url}/`);
    // A soğuma süresinde: istek doğrudan B'ye.
    await connection.getVersion();
    expect([a.state.hits, b.state.hits]).toEqual([1, 2]);
    // Soğuma bitince A yeniden denenir (B tercih edildiği için önce B).
    now = 31_000;
    a.state.behavior = 'ok';
    b.state.behavior = '503';
    await connection.getVersion();
    expect(failover.endpoint()).toBe(`${a.url}/`);
  });

  it('gövdesiz Request nesnesini yöntemi ve başlıklarıyla iletir', async () => {
    const server = await rpcServer('ok');
    const failover = createFailoverFetch({ endpoints: [server.url], timeoutMs: 1000, cooldownMs: 0 });
    const response = await failover(new Request(`${server.url}/health`, { method: 'GET' }));
    expect(response.status).toBe(200);
  });

  it('429 ve zaman aşımı failover sebebidir; JSON-RPC hatası değildir', async () => {
    const limited = await rpcServer('429');
    const hanging = await rpcServer('hang');
    const healthy = await rpcServer('rpc-error');
    const events: FailoverReason[] = [];
    const failover = createFailoverFetch({
      endpoints: [limited.url, hanging.url, healthy.url],
      timeoutMs: 200,
      cooldownMs: 30_000,
      onFailover: (event) => events.push(event.reason),
    });
    const { url, init } = rpc(limited.url);
    const response = await failover(url, init);
    expect(events).toEqual(['rate_limited', 'timeout']);
    expect(await response.json()).toMatchObject({ error: { code: -32601 } });
    expect(healthy.state.hits).toBe(1);
  });

  it('bütün uçlar düşerse son yanıt ya da son hata döner; çağıranın iptali failover yapmaz', async () => {
    const a = await rpcServer('503');
    const b = await rpcServer('503');
    const failover = createFailoverFetch({ endpoints: [a.url, b.url], timeoutMs: 1000, cooldownMs: 1000 });
    const { init } = rpc(a.url);
    expect((await failover(a.url, init)).status).toBe(503);

    const dead = createFailoverFetch({
      endpoints: ['http://127.0.0.1:1', 'http://127.0.0.1:2'],
      timeoutMs: 1000,
      cooldownMs: 1000,
    });
    await expect(dead('http://127.0.0.1:1', init)).rejects.toThrow();

    const hanging = await rpcServer('hang');
    const other = await rpcServer('ok');
    const controller = new AbortController();
    const cancellable = createFailoverFetch({ endpoints: [hanging.url, other.url], timeoutMs: 5000, cooldownMs: 1000 });
    const pending = cancellable(hanging.url, { ...init, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect(other.state.hits).toBe(0);
  });

  it('yapılandırmayı ve isteği doğrular', async () => {
    expect(() => createFailoverFetch({ endpoints: [], timeoutMs: 1, cooldownMs: 0 })).toThrow(/en az bir/);
    expect(() => createFailoverFetch({ endpoints: ['ws://x'], timeoutMs: 1, cooldownMs: 0 })).toThrow(/http/);
    expect(() => createFailoverFetch({ endpoints: ['http://a'], timeoutMs: 0, cooldownMs: 0 })).toThrow(/timeoutMs/);
    const failover = createFailoverFetch({ endpoints: ['http://127.0.0.1:9'], timeoutMs: 100, cooldownMs: 0 });
    await expect(failover('http://başka.example/', {})).rejects.toThrow(/RPC uçlarından/);
    await expect(failover('http://127.0.0.1:9', { method: 'POST', body: new Blob(['x']) })).rejects.toThrow(
      /yeniden gönderilebilir/,
    );
    await expect(failover(new Request('http://127.0.0.1:9', { method: 'POST', body: 'x' }))).rejects.toThrow(
      /yeniden gönderilebilir/,
    );
  });
});
