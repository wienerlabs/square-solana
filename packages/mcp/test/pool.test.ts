// Havuzlu MCP istemcisi: bellek içi taşımalı gerçek MCP sunucularına karşı. Bağlantı yeniden kullanımı,
// eşzamanlılık sınırı, yeniden bağlanma, tool önbelleği ve kapatma. stdio ve Streamable HTTP taşımaları gerçek
// süreç ve HTTP sunucusuyla denenir (stdio: derlenmiş Square MCP sunucusu).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpClientPool, McpPoolError, type McpPoolOptions } from '../src/client/index.js';
import { PROGRAM_IDS } from './helpers/world.js';

/** Sayaçlı test sunucusu: her bağlantı yeni bir `McpServer` açar. */
class Fixture {
  connections = 0;
  listRequests = 0;
  running = 0;
  maxRunning = 0;
  failConnects = 0;
  readonly servers: { server: McpServer; transport: InMemoryTransport }[] = [];
  private gates: (() => void)[] = [];

  constructor(private readonly tools: string[] = ['echo', 'slow']) {}

  /** Bekleyen `slow` çağrılarını bırakır. */
  open(): void {
    for (const release of this.gates.splice(0)) release();
  }

  async waitRunning(count: number): Promise<void> {
    while (this.running < count) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  readonly create = async () => {
    if (this.failConnects > 0) {
      this.failConnects -= 1;
      throw new Error('sunucu ayakta değil');
    }
    this.connections += 1;
    const server = new McpServer({ name: 'fixture', version: '1.0.0' });
    if (this.tools.includes('echo')) {
      server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: 'text', text }],
      }));
    }
    if (this.tools.includes('slow')) {
      server.registerTool('slow', {}, async () => {
        this.running += 1;
        this.maxRunning = Math.max(this.maxRunning, this.running);
        await new Promise<void>((resolve) => this.gates.push(resolve));
        this.running -= 1;
        return { content: [{ type: 'text', text: 'done' }] };
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const handler = serverTransport.onmessage!;
    serverTransport.onmessage = (message: JSONRPCMessage, extra) => {
      if ('method' in message && message.method === 'tools/list') this.listRequests += 1;
      handler(message, extra);
    };
    this.servers.push({ server, transport: serverTransport });
    return clientTransport;
  };
}

let pool: McpClientPool | null = null;
afterEach(async () => {
  await pool?.close();
  pool = null;
});

function makePool(servers: Record<string, Fixture>, overrides: Partial<McpPoolOptions> = {}) {
  pool = new McpClientPool({
    servers: Object.fromEntries(
      Object.entries(servers).map(([name, fixture]) => [name, { type: 'transport' as const, create: fixture.create }]),
    ),
    maxConcurrency: 2,
    toolCacheTtlMs: 60_000,
    requestTimeoutMs: 5_000,
    reconnect: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 },
    ...overrides,
  });
  return pool;
}

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

describe('McpClientPool', () => {
  it('bağlantıyı tembel açar ve yeniden kullanır', async () => {
    const fixture = new Fixture();
    const p = makePool({ a: fixture });
    expect(p.servers()).toEqual(['a']);
    expect(p.stats('a')).toMatchObject({ connected: false, connects: 0 });
    const results = await Promise.all([1, 2, 3, 4].map((i) => p.callTool('a', 'echo', { text: `m${i}` })));
    expect(results.map(text)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(fixture.connections).toBe(1);
    expect(p.stats('a')).toMatchObject({ connected: true, active: 0, queued: 0, connects: 1 });
  });

  it('sunucu başına eşzamanlılığı sınırlar', async () => {
    const fixture = new Fixture();
    const p = makePool({ a: fixture }, { maxConcurrency: 2 });
    const calls = Array.from({ length: 5 }, () => p.callTool('a', 'slow'));
    await fixture.waitRunning(2);
    expect(p.stats('a')).toMatchObject({ active: 2, queued: 3 });
    while (fixture.running > 0 || p.stats('a').queued > 0) {
      fixture.open();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await Promise.all(calls)).map(text)).toEqual(Array(5).fill('done'));
    expect(fixture.maxRunning).toBe(2);
    expect(p.stats('a')).toMatchObject({ active: 0, queued: 0 });
  });

  it('kopan bağlantıyı bir sonraki istekte yeniden açar', async () => {
    const fixture = new Fixture();
    const p = makePool({ a: fixture });
    await p.callTool('a', 'echo', { text: 'x' });
    await p.listTools('a');
    await fixture.servers[0]!.transport.close();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(p.stats('a')).toMatchObject({ connected: false, toolsCached: false });
    expect(text(await p.callTool('a', 'echo', { text: 'y' }))).toBe('y');
    expect(fixture.connections).toBe(2);
    expect(p.stats('a').connects).toBe(2);
  });

  it('açılışı üstel beklemeyle yeniden dener; tükenince connect_failed', async () => {
    const fixture = new Fixture();
    fixture.failConnects = 2;
    const p = makePool({ a: fixture }, { reconnect: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 2 } });
    expect(text(await p.callTool('a', 'echo', { text: 'ok' }))).toBe('ok');

    const down = new Fixture();
    down.failConnects = 10;
    const q = new McpClientPool({
      servers: { b: { type: 'transport', create: down.create } },
      maxConcurrency: 1,
      toolCacheTtlMs: 0,
      requestTimeoutMs: 1_000,
      reconnect: { maxAttempts: 2, backoffMs: 1, maxBackoffMs: 1 },
    });
    const error = await q.callTool('b', 'echo', { text: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpPoolError);
    expect(error).toMatchObject({ code: 'connect_failed', server: 'b' });
    expect((error as Error).message).toMatch(/ayakta değil/);
    expect(down.failConnects).toBe(8);
    await q.close();
  });

  it('tool listesini önbellekler; süre dolunca, refresh ile ve list_changed bildirimiyle yeniler', async () => {
    let clock = 0;
    const fixture = new Fixture(['echo']);
    const p = makePool({ a: fixture }, { toolCacheTtlMs: 1_000, now: () => clock });
    const [first, second] = await Promise.all([p.listTools('a'), p.listTools('a')]);
    expect(first.map((tool) => tool.name)).toEqual(['echo']);
    expect(second).toBe(first);
    await p.listTools('a');
    expect(fixture.listRequests).toBe(1);

    clock = 1_500;
    await p.listTools('a');
    expect(fixture.listRequests).toBe(2);
    await p.listTools('a', { refresh: true });
    expect(fixture.listRequests).toBe(3);

    fixture.servers[0]!.server.registerTool('added', {}, async () => ({ content: [] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(p.stats('a').toolsCached).toBe(false);
    expect((await p.listTools('a')).map((tool) => tool.name)).toEqual(['echo', 'added']);
  });

  it('bütün sunucularda keşif, ada göre çağrı, belirsiz ve olmayan tool', async () => {
    const a = new Fixture(['echo']);
    const b = new Fixture(['echo', 'slow']);
    const down = new Fixture();
    down.failConnects = 100;
    const p = makePool({ a, b, down }, { reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 } });
    const { tools, errors } = await p.listAllTools();
    expect(tools.map((tool) => `${tool.server}:${tool.name}`)).toEqual(['a:echo', 'b:echo', 'b:slow']);
    expect(errors.map((entry) => entry.server)).toEqual(['down']);
    expect((await p.findTool('echo')).map((tool) => tool.server)).toEqual(['a', 'b']);
    await expect(p.callToolByName('echo', { text: 'x' })).rejects.toMatchObject({ code: 'ambiguous_tool' });
    await expect(p.callToolByName('nope')).rejects.toMatchObject({ code: 'tool_not_found' });
    const pending = p.callToolByName('slow');
    await b.waitRunning(1);
    b.open();
    expect(await pending).toMatchObject({ server: 'b', content: [{ type: 'text', text: 'done' }] });
    expect(() => p.stats('x')).toThrow(McpPoolError);
    await expect(p.callTool('x', 'echo')).rejects.toMatchObject({ code: 'unknown_server' });
  });

  it('kapatma bağlantıları kapatır, kuyruğu reddeder, sonraki istekleri engeller', async () => {
    const fixture = new Fixture();
    const p = makePool({ a: fixture }, { maxConcurrency: 1 });
    const running = p.callTool('a', 'slow');
    await fixture.waitRunning(1);
    const queued = p.callTool('a', 'echo', { text: 'q' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(p.stats('a').queued).toBe(1);
    let serverClosed = false;
    fixture.servers[0]!.server.server.onclose = () => {
      serverClosed = true;
    };
    await p.close();
    await p.close();
    await expect(queued).rejects.toMatchObject({ code: 'closed' });
    await expect(running).rejects.toThrow();
    expect(serverClosed).toBe(true);
    await expect(p.callTool('a', 'echo', { text: 'x' })).rejects.toMatchObject({ code: 'closed' });
    await expect(p.listTools('a')).rejects.toMatchObject({ code: 'closed' });
  });

  it('bağlantı açılırken kapatılan havuz yeni bağlantıyı kapatır', async () => {
    let release!: () => void;
    const fixture = new Fixture();
    const slowCreate = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return fixture.create();
    };
    pool = new McpClientPool({
      servers: { a: { type: 'transport', create: slowCreate } },
      maxConcurrency: 1,
      toolCacheTtlMs: 0,
      requestTimeoutMs: 1_000,
      reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    });
    const call = pool.callTool('a', 'echo', { text: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = pool.close();
    release();
    await closing;
    await expect(call).rejects.toMatchObject({ code: 'closed' });
  });

  it('geçersiz seçenekleri reddeder', () => {
    const base = {
      servers: { a: { type: 'transport' as const, create: new Fixture().create } },
      maxConcurrency: 1,
      toolCacheTtlMs: 0,
      requestTimeoutMs: 1,
      reconnect: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    };
    expect(() => new McpClientPool({ ...base, maxConcurrency: 0 })).toThrow(/maxConcurrency/);
    expect(() => new McpClientPool({ ...base, servers: {} })).toThrow(/en az bir/);
  });
});

describe('taşımalar', () => {
  const base = {
    maxConcurrency: 2,
    toolCacheTtlMs: 60_000,
    requestTimeoutMs: 5_000,
    reconnect: { maxAttempts: 1, backoffMs: 1, maxBackoffMs: 1 },
  };

  it('stdio: derlenmiş Square MCP sunucusunu alt süreç olarak açar', async () => {
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    pool = new McpClientPool({
      ...base,
      servers: {
        square: {
          type: 'stdio',
          command: process.execPath,
          args: [bin],
          env: {
            PATH: process.env['PATH'] ?? '',
            SQUARE_MCP_CLUSTER: 'localnet',
            // Kapalı port: araç çağrısı RPC hatasını araç hatası olarak döner, süreç düşmez.
            SQUARE_MCP_RPC_URL: 'http://127.0.0.1:9',
            SQUARE_MCP_TIMEOUT_MS: '1000',
            SQUARE_MCP_CARD_MAX_BYTES: '65536',
            SQUARE_PROGRAM_ID_REGISTRY: PROGRAM_IDS.registry.toBase58(),
            SQUARE_PROGRAM_ID_POLICY: PROGRAM_IDS.policy.toBase58(),
            SQUARE_PROGRAM_ID_VERIFIER: PROGRAM_IDS.verifier.toBase58(),
            SQUARE_PROGRAM_ID_ESCROW: PROGRAM_IDS.escrow.toBase58(),
          },
        },
      },
    });
    expect(await pool.listTools('square')).toHaveLength(10);
    const result = await pool.callToolByName('square_settlement_stats');
    expect(result.server).toBe('square');
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Square: /);
  });

  it('Streamable HTTP: başlıklar sunucuya gider', async () => {
    const seen: (string | undefined)[] = [];
    const http: Server = createServer(async (req, res) => {
      seen.push(req.headers['authorization']);
      const server = new McpServer({ name: 'remote', version: '0' });
      server.registerTool('ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => void transport.close());
      await server.connect(transport);
      await transport.handleRequest(req, res);
    }).listen(0, '127.0.0.1');
    await once(http, 'listening');
    try {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
      pool = new McpClientPool({
        ...base,
        servers: { remote: { type: 'http', url, headers: { authorization: 'Bearer agent' } } },
      });
      expect(text(await pool.callTool('remote', 'ping'))).toBe('pong');
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((value) => value === 'Bearer agent')).toBe(true);
    } finally {
      await pool?.close();
      pool = null;
      http.closeAllConnections();
      http.close();
    }
  });
});
