// Streamable HTTP taşıması: havuzlu istemcinin `http` hedefiyle (SDK'nın StreamableHTTPClientTransport'u)
// uçtan uca; oturum, host denetimi ve hata yolları ham HTTP istekleriyle.
import { afterEach, describe, expect, it } from 'vitest';
import { McpClientPool } from '../src/client/index.js';
import { createApi } from '../src/api.js';
import { MAX_BODY_BYTES, startHttpServer, type HttpServerHandle } from '../src/http.js';
import { createSquareMcpServer } from '../src/server.js';
import { FakeApi } from './helpers/fake-api.js';
import { jobView } from './helpers/fixtures.js';

let handle: HttpServerHandle | null = null;
let pool: McpClientPool | null = null;
afterEach(async () => {
  await pool?.close();
  await handle?.close();
  pool = null;
  handle = null;
});

async function start(allowedHosts: string[] | null = null) {
  const api = new FakeApi();
  handle = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    allowedHosts,
    createServer: () =>
      createSquareMcpServer({
        network: 'devnet',
        api: createApi({ apiUrl: 'http://square.test', timeoutMs: 1000, apiKey: null, fetch: api.fetch }),
      }),
  });
  return { api, handle };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body,
  });

describe('Streamable HTTP', () => {
  it('havuzlu istemciyle tool listesi ve çağrı; her istemci kendi oturumu', async () => {
    const { api, handle } = await start();
    const job = jobView();
    api.jobs.set(job.address, job);
    const target = { type: 'http' as const, url: handle.url, headers: { 'x-test': '1' } };
    pool = new McpClientPool({
      servers: { square: target, again: target },
      maxConcurrency: 4,
      toolCacheTtlMs: 60_000,
      requestTimeoutMs: 5_000,
      reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    });
    const tools = await pool.listTools('square');
    expect(tools.map((tool) => tool.name)).toContain('square_find_work');
    expect(tools.map((tool) => tool.name)).not.toContain('square_open_job');
    const result = await pool.callTool('square', 'square_find_work', {});
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ network: 'devnet', total: 1 });
    await pool.listTools('again');
    expect(handle.sessionCount()).toBe(2);
  });

  it('sağlık, yol, oturum ve gövde hataları', async () => {
    const { handle } = await start();
    const base = handle.url.replace(/\/mcp$/, '');
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok', sessions: 0 });
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect((await post(handle.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(400);
    expect((await post(handle.url, '{', {})).status).toBe(400);
    expect((await post(handle.url, JSON.stringify(initialize), { 'mcp-session-id': 'yok' })).status).toBe(404);
    expect((await post(handle.url, 'x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);

    const opened = await post(handle.url, JSON.stringify(initialize));
    expect(opened.status).toBe(200);
    const session = opened.headers.get('mcp-session-id')!;
    await opened.text();
    expect(handle.sessionCount()).toBe(1);
    const closed = await fetch(handle.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' },
    });
    expect(closed.status).toBe(200);
    expect(handle.sessionCount()).toBe(0);
  });

  it('izinli host listesi dışındaki Host başlığını reddeder', async () => {
    const { handle } = await start(['mcp.square.test']);
    const denied = await post(handle.url, JSON.stringify(initialize));
    expect(denied.status).toBe(403);
    const port = new URL(handle.url).port;
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/health', headers: { host: `mcp.square.test:${port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });
});
