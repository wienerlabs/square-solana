// Havuzlu MCP istemcisi: bağlantıların yeniden kullanımı, sunucu başına sınır ve sıra, zaman aşımı, kopan bağlantı,
// boşta kapanma, kapatma. Bellek içi sunucular sayılabilir; stdio ve Streamable HTTP taşımaları gerçek süreç ve
// HTTP sunucusuyla denenir (stdio: derlenmiş Square MCP sunucusu).
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMcpClientPool, type McpClientPool, type McpClientPoolOptions } from '../src/client/pool.js';
import { PROGRAM_IDS } from './helpers/world.js';

const pools: McpClientPool[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

/** Her bağlantıda yeni bir araç sunucusu; `gate` açılana kadar `slow` bekler. */
function toolServer() {
  let gate: () => void = () => undefined;
  let opened = new Promise<void>((resolve) => (gate = resolve));
  const servers: { transport: Transport }[] = [];
  const build = () => {
    const server = new McpServer({ name: 'tools', version: '0' });
    server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
      content: [{ type: 'text', text }],
    }));
    server.registerTool('slow', {}, async () => {
      await opened;
      return { content: [{ type: 'text', text: 'done' }] };
    });
    server.registerTool('never', {}, () => new Promise(() => undefined));
    return server;
  };
  return {
    servers,
    open() {
      gate();
      opened = new Promise<void>((resolve) => (gate = resolve));
    },
    async transport(): Promise<Transport> {
      const [client, server] = InMemoryTransport.createLinkedPair();
      await build().connect(server);
      servers.push({ transport: server });
      return client;
    },
  };
}

function pool(options: Partial<McpClientPoolOptions> & Pick<McpClientPoolOptions, 'transport'>) {
  const created = createMcpClientPool({
    servers: [{ name: 'tools', transport: { kind: 'http', url: 'http://unused.test/mcp' } }],
    clientInfo: { name: 'agent', version: '0' },
    maxConnectionsPerServer: 2,
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 5_000,
    ...options,
  });
  pools.push(created);
  return created;
}

const text = (result: { content: unknown }) => (result.content as { text: string }[])[0]!.text;

describe('havuz', () => {
  it('sıralı çağrılar aynı bağlantıyı kullanır; araç listesi', async () => {
    const tools = toolServer();
    const client = pool({ transport: () => tools.transport() });
    expect((await client.listTools('tools')).map((tool) => tool.name)).toEqual(['echo', 'slow', 'never']);
    for (const word of ['a', 'b', 'c']) expect(text(await client.callTool('tools', 'echo', { text: word }))).toBe(word);
    expect(tools.servers).toHaveLength(1);
    expect(client.stats()).toEqual([{ server: 'tools', open: 1, busy: 0, waiting: 0 }]);
  });

  it('sunucu başına en fazla iki bağlantı; fazlası sırada bekler ve boşalan bağlantıyı alır', async () => {
    const tools = toolServer();
    const client = pool({ transport: () => tools.transport() });
    const calls = Array.from({ length: 5 }, () => client.callTool('tools', 'slow'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.stats()).toEqual([{ server: 'tools', open: 2, busy: 2, waiting: 3 }]);
    tools.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    tools.open();
    await new Promise((resolve) => setTimeout(resolve, 50));
    tools.open();
    expect((await Promise.all(calls)).map(text)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(tools.servers).toHaveLength(2);
    expect(client.stats()).toEqual([{ server: 'tools', open: 2, busy: 0, waiting: 0 }]);
  });

  it('zaman aşımına uğrayan bağlantı atılır, sonraki çağrı yenisini açar; araç çağrısı yeniden denenmez', async () => {
    const tools = toolServer();
    const client = pool({ transport: () => tools.transport(), requestTimeoutMs: 100 });
    await expect(client.callTool('tools', 'never')).rejects.toThrow(/timed out/i);
    expect(client.stats()[0]).toMatchObject({ open: 0, busy: 0 });
    expect(text(await client.callTool('tools', 'echo', { text: 'x' }))).toBe('x');
    expect(tools.servers).toHaveLength(2);
  });

  it('kopan bağlantı havuzdan atılır', async () => {
    const tools = toolServer();
    const client = pool({ transport: () => tools.transport() });
    await client.callTool('tools', 'echo', { text: 'x' });
    await tools.servers[0]!.transport.close();
    expect(text(await client.callTool('tools', 'echo', { text: 'y' }))).toBe('y');
    expect(tools.servers).toHaveLength(2);
    expect(client.stats()[0]).toMatchObject({ open: 1 });
  });

  it('boşta kalan bağlantı kapanır', async () => {
    const tools = toolServer();
    const client = pool({ transport: () => tools.transport(), idleTimeoutMs: 40 });
    await client.callTool('tools', 'echo', { text: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(client.stats()[0]).toMatchObject({ open: 0 });
  });

  it('bağlanamayan sunucu yer tutmaz; tanımsız sunucu, geçersiz seçenek ve kapatma', async () => {
    const tools = toolServer();
    let fail = true;
    const client = pool({
      maxConnectionsPerServer: 1,
      transport: () => {
        if (fail) throw new Error('bağlantı reddedildi');
        return tools.transport();
      },
    });
    await expect(client.callTool('tools', 'echo', { text: 'x' })).rejects.toThrow(/reddedildi/);
    fail = false;
    expect(text(await client.callTool('tools', 'echo', { text: 'x' }))).toBe('x');
    await expect(client.callTool('nope', 'echo')).rejects.toThrow(/tanımsız MCP sunucusu/);

    const waiting = client.callTool('tools', 'slow');
    const queued = client.callTool('tools', 'slow');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(client.stats()[0]).toMatchObject({ waiting: 1 });
    await client.close();
    await expect(queued).rejects.toThrow(/kapatıldı/);
    tools.open();
    expect(text(await waiting)).toBe('done');
    await expect(client.listTools('tools')).rejects.toThrow(/kapatıldı/);

    const base = { servers: [], clientInfo: { name: 'a', version: '0' }, idleTimeoutMs: 1, requestTimeoutMs: 1 };
    expect(() => createMcpClientPool({ ...base, maxConnectionsPerServer: 0 })).toThrow(/pozitif tamsayı/);
    expect(() => createMcpClientPool({ ...base, maxConnectionsPerServer: 1, idleTimeoutMs: 0 })).toThrow(/pozitif/);
    const spec = { name: 'x', transport: { kind: 'http' as const, url: 'http://x.test' } };
    expect(() => createMcpClientPool({ ...base, maxConnectionsPerServer: 1, servers: [spec, spec] })).toThrow(
      /iki kez/,
    );
  });
});

describe('taşımalar', () => {
  it('stdio: derlenmiş Square MCP sunucusunu alt süreç olarak açar', async () => {
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const client = pool({
      transport: undefined,
      servers: [
        {
          name: 'square',
          transport: {
            kind: 'stdio',
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
      ],
    });
    expect(await client.listTools('square')).toHaveLength(10);
    const result = await client.callTool('square', 'square_settlement_stats');
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
      const client = pool({
        transport: undefined,
        servers: [{ name: 'remote', transport: { kind: 'http', url, headers: { authorization: 'Bearer agent' } } }],
      });
      expect(text(await client.callTool('remote', 'ping'))).toBe('pong');
      expect(seen.every((value) => value === 'Bearer agent')).toBe(true);
    } finally {
      http.closeAllConnections();
      http.close();
    }
  });
});
