// Agent'lar için havuzlu MCP istemcisi (BE-28). Bir agent birden çok MCP sunucusunun (Square'in sunucusu, kendi
// araç sunucuları) araçlarını çağırır; her sunucuya bağlantılar havuzdan verilir:
// - Sunucu başına en fazla `maxConnectionsPerServer` bağlantı; dolunca çağrı sırada bekler (FIFO).
// - Boşta kalan bağlantı yeniden kullanılır; `idleTimeoutMs` boyunca kullanılmayan kapatılır.
// - Taşıması kopan bağlantı havuzdan atılır, sıradaki çağrı yenisini açar. Araç çağrısı kendiliğinden yeniden
//   denenmez: yazma araçları idempotent değildir, tekrarı çağıran karar verir.
// - Her istek `requestTimeoutMs` ile sınırlıdır.
// Taşımalar: stdio (sunucuyu alt süreç olarak açar) ve Streamable HTTP.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

export type McpServerTransportSpec =
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
      readonly cwd?: string;
    }
  | { readonly kind: 'http'; readonly url: string; readonly headers?: Readonly<Record<string, string>> };

export interface McpServerSpec {
  readonly name: string;
  readonly transport: McpServerTransportSpec;
}

export interface McpClientPoolOptions {
  readonly servers: readonly McpServerSpec[];
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly maxConnectionsPerServer: number;
  readonly idleTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** Taşıma fabrikası; verilmezse spec'teki taşıma kurulur (testler bellek içi taşıma verir). */
  readonly transport?: (spec: McpServerSpec) => Transport | Promise<Transport>;
}

export interface McpPoolStats {
  readonly server: string;
  readonly open: number;
  readonly busy: number;
  readonly waiting: number;
}

export interface McpClientPool {
  listTools(server: string): Promise<Tool[]>;
  callTool(server: string, name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  stats(): McpPoolStats[];
  /** Bütün bağlantıları kapatır; bekleyen çağrılar reddedilir, sonraki çağrılar hata verir. */
  close(): Promise<void>;
}

interface Connection {
  readonly client: Client;
  broken: boolean;
  lastUsed: number;
}

interface ServerPool {
  readonly spec: McpServerSpec;
  readonly idle: Connection[];
  readonly waiters: { resolve: (connection: Connection) => void; reject: (error: Error) => void }[];
  open: number;
  busy: number;
}

function defaultTransport(spec: McpServerSpec): Transport {
  const { transport } = spec;
  if (transport.kind === 'stdio') {
    return new StdioClientTransport({
      command: transport.command,
      args: [...(transport.args ?? [])],
      ...(transport.env && { env: { ...transport.env } }),
      ...(transport.cwd && { cwd: transport.cwd }),
      stderr: 'pipe',
    });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), {
    ...(transport.headers && { requestInit: { headers: { ...transport.headers } } }),
  });
}

export function createMcpClientPool(options: McpClientPoolOptions): McpClientPool {
  if (!Number.isInteger(options.maxConnectionsPerServer) || options.maxConnectionsPerServer < 1) {
    throw new Error('maxConnectionsPerServer pozitif tamsayı olmalı');
  }
  if (!(options.idleTimeoutMs > 0) || !(options.requestTimeoutMs > 0)) {
    throw new Error('idleTimeoutMs ve requestTimeoutMs pozitif olmalı');
  }
  const pools = new Map<string, ServerPool>();
  for (const spec of options.servers) {
    if (pools.has(spec.name)) throw new Error(`MCP sunucusu iki kez tanımlı: ${spec.name}`);
    pools.set(spec.name, { spec, idle: [], waiters: [], open: 0, busy: 0 });
  }
  const makeTransport = options.transport ?? defaultTransport;
  let closed = false;

  const poolOf = (server: string): ServerPool => {
    if (closed) throw new Error('MCP istemci havuzu kapatıldı');
    const pool = pools.get(server);
    if (!pool) throw new Error(`tanımsız MCP sunucusu: ${server}`);
    return pool;
  };

  async function connect(pool: ServerPool): Promise<Connection> {
    const client = new Client({ name: options.clientInfo.name, version: options.clientInfo.version });
    const connection: Connection = { client, broken: false, lastUsed: Date.now() };
    client.onclose = () => {
      connection.broken = true;
    };
    client.onerror = () => {
      connection.broken = true;
    };
    await client.connect(await makeTransport(pool.spec), { timeout: options.requestTimeoutMs });
    return connection;
  }

  async function acquire(pool: ServerPool): Promise<Connection> {
    for (let connection = pool.idle.pop(); connection; connection = pool.idle.pop()) {
      if (!connection.broken) {
        pool.busy += 1;
        return connection;
      }
      pool.open -= 1;
    }
    if (pool.open < options.maxConnectionsPerServer) {
      pool.open += 1;
      pool.busy += 1;
      try {
        return await connect(pool);
      } catch (error) {
        pool.open -= 1;
        pool.busy -= 1;
        handOff(pool);
        throw error;
      }
    }
    return new Promise<Connection>((resolve, reject) => pool.waiters.push({ resolve, reject }));
  }

  /** Bırakılan yer sıradakine geçer: sağlam bağlantı ya da (kopuksa) yeni bağlantı hakkı. */
  function handOff(pool: ServerPool) {
    const waiter = pool.waiters.shift();
    if (!waiter) return;
    acquire(pool).then(waiter.resolve, waiter.reject);
  }

  function release(pool: ServerPool, connection: Connection) {
    pool.busy -= 1;
    connection.lastUsed = Date.now();
    if (connection.broken || closed) {
      pool.open -= 1;
      void connection.client.close().catch(() => undefined);
      handOff(pool);
      return;
    }
    const waiter = pool.waiters.shift();
    if (waiter) {
      pool.busy += 1;
      waiter.resolve(connection);
      return;
    }
    pool.idle.push(connection);
  }

  async function use<T>(server: string, work: (client: Client) => Promise<T>): Promise<T> {
    const pool = poolOf(server);
    const connection = await acquire(pool);
    try {
      return await work(connection.client);
    } catch (error) {
      // İstek zaman aşımı ya da taşıma hatası: bağlantının durumu belirsiz, yeniden kullanılmaz.
      connection.broken = true;
      throw error;
    } finally {
      release(pool, connection);
    }
  }

  const reaper = setInterval(
    () => {
      const now = Date.now();
      for (const pool of pools.values()) {
        for (let index = pool.idle.length - 1; index >= 0; index -= 1) {
          const connection = pool.idle[index]!;
          if (now - connection.lastUsed < options.idleTimeoutMs) continue;
          pool.idle.splice(index, 1);
          pool.open -= 1;
          void connection.client.close().catch(() => undefined);
        }
      }
    },
    Math.max(1, Math.floor(options.idleTimeoutMs / 2)),
  );
  reaper.unref();

  return {
    async listTools(server) {
      return use(server, async (client) => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: options.requestTimeoutMs });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      });
    },

    async callTool(server, name, args = {}) {
      return use(server, async (client) => {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          timeout: options.requestTimeoutMs,
        });
        return result as CallToolResult;
      });
    },

    stats() {
      return [...pools.values()].map((pool) => ({
        server: pool.spec.name,
        open: pool.open,
        busy: pool.busy,
        waiting: pool.waiters.length,
      }));
    },

    async close() {
      if (closed) return;
      closed = true;
      clearInterval(reaper);
      const closing: Promise<void>[] = [];
      for (const pool of pools.values()) {
        for (const waiter of pool.waiters.splice(0)) waiter.reject(new Error('MCP istemci havuzu kapatıldı'));
        for (const connection of pool.idle.splice(0)) {
          pool.open -= 1;
          closing.push(connection.client.close().catch(() => undefined));
        }
      }
      await Promise.all(closing);
    },
  };
}
