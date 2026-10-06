// Agent'lar için havuzlu MCP istemcisi: bir agent'ın birden çok MCP sunucusuna (Square MCP, başka agent'ların
// sunucuları, araç sunucuları) bağlantıları tek yerden yönetilir.
// - Bağlantı yeniden kullanımı: sunucu başına tek `Client`, ilk istekte tembel açılır; eşzamanlı açılış
//   istekleri aynı bağlantıyı bekler.
// - Eşzamanlılık sınırı: sunucu başına aynı anda yürüyen istek sayısı `maxConcurrency`; fazlası sırayla bekler.
// - Yeniden bağlanma: bağlantı koparsa (`onclose`) bir sonraki istek yeniden bağlanır; açılış üstel bekleme
//   ile `maxAttempts` kez denenir. Yolda kopan tool çağrısı yeniden denenmez (tool'lar idempotent olmayabilir,
//   ör. tx gönderimi); `listTools` idempotent olduğu için bir kez yeniden denenir.
// - Tool keşfi önbelleği: sunucu başına tool listesi `toolCacheTtlMs` boyunca tutulur; sunucunun
//   `notifications/tools/list_changed` bildirimi ve yeniden bağlanma önbelleği düşürür.
// - Kapatma: `close()` bütün bağlantıları kapatır, kuyruktaki istekleri reddeder; sonraki istekler hata alır.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { packageInfo } from '../package-info.js';

export type McpServerTarget =
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      /** Alt sürecin ortamı; verilmezse SDK'nın güvenli varsayılan değişkenleri. */
      env?: Record<string, string>;
      cwd?: string;
    }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  /** Özel taşıma (ör. bellek içi); her bağlantı denemesinde yenisi üretilir. */
  | { type: 'transport'; create: () => Transport | Promise<Transport> };

export interface McpPoolOptions {
  /** Sunucu adı → hedef. */
  servers: Record<string, McpServerTarget>;
  /** Sunucu başına aynı anda yürüyen istek sınırı. */
  maxConcurrency: number;
  /** Tool listesi önbelleğinin ömrü (ms). */
  toolCacheTtlMs: number;
  /** Tek isteğin (tool çağrısı, liste) zaman aşımı (ms). */
  requestTimeoutMs: number;
  reconnect: {
    /** Bağlantı açılışında toplam deneme sayısı. */
    maxAttempts: number;
    /** İlk bekleme; her denemede iki katına çıkar. */
    backoffMs: number;
    /** Bekleme üst sınırı. */
    maxBackoffMs: number;
  };
  clientInfo?: { name: string; version: string };
  /** Saat (test için). */
  now?: () => number;
}

export type McpPoolErrorCode = 'unknown_server' | 'closed' | 'connect_failed' | 'tool_not_found' | 'ambiguous_tool';

export class McpPoolError extends Error {
  constructor(
    readonly code: McpPoolErrorCode,
    message: string,
    readonly server: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpPoolError';
  }
}

export interface PoolTool extends Tool {
  /** Tool'u sunan sunucunun havuzdaki adı. */
  server: string;
}

export interface ServerStats {
  connected: boolean;
  /** Şu an yürüyen istekler. */
  active: number;
  /** Sırada bekleyen istekler. */
  queued: number;
  /** Başarılı bağlantı açılışları (ilk bağlantı + yeniden bağlanmalar). */
  connects: number;
  toolsCached: boolean;
}

export interface CallOptions {
  /** Bu çağrının zaman aşımı; verilmezse `requestTimeoutMs`. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const positive = (name: string, value: number, allowZero = false) => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`${name} pozitif tamsayı olmalı`);
};

/** Bağlantının koptuğunu gösteren SDK hataları. */
const isDisconnect = (error: unknown) =>
  error instanceof Error && /not connected|connection closed/i.test(error.message);

class ServerConnection {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  private tools: { list: Tool[]; at: number } | null = null;
  private listing: Promise<Tool[]> | null = null;
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private connects = 0;
  private closed = false;

  constructor(
    readonly name: string,
    private readonly target: McpServerTarget,
    private readonly options: McpPoolOptions,
  ) {}

  stats(): ServerStats {
    return {
      connected: this.client !== null,
      active: this.active,
      queued: this.waiters.length,
      connects: this.connects,
      toolsCached: this.tools !== null,
    };
  }

  private closedError() {
    return new McpPoolError('closed', 'MCP havuzu kapatıldı', this.name);
  }

  private async acquire(): Promise<void> {
    if (this.closed) throw this.closedError();
    if (this.active < this.options.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private release(): void {
    const next = this.waiters.shift();
    // Sıradaki istek yuvayı devralır; `active` değişmez.
    if (next) next.resolve();
    else this.active -= 1;
  }

  /** Yuva alır, bağlantıyı (gerekirse yeniden) açar ve işi yürütür. */
  async run<T>(work: (client: Client) => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work(await this.connect());
    } finally {
      this.release();
    }
  }

  private async transport(): Promise<Transport> {
    const target = this.target;
    switch (target.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: target.command,
          ...(target.args && { args: target.args }),
          ...(target.env && { env: target.env }),
          ...(target.cwd && { cwd: target.cwd }),
          stderr: 'pipe',
        });
      case 'http':
        return new StreamableHTTPClientTransport(new URL(target.url), {
          ...(target.headers && { requestInit: { headers: target.headers } }),
        });
      case 'transport':
        return target.create();
    }
  }

  private connect(): Promise<Client> {
    if (this.closed) return Promise.reject(this.closedError());
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<Client> {
    const { maxAttempts, backoffMs, maxBackoffMs } = this.options.reconnect;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(maxBackoffMs, backoffMs * 2 ** (attempt - 2))));
      }
      if (this.closed) throw this.closedError();
      const client = new Client(this.options.clientInfo ?? { name: packageInfo.name, version: packageInfo.version });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        if (this.client === client) this.tools = null;
      });
      client.onclose = () => {
        if (this.client === client) {
          this.client = null;
          this.tools = null;
        }
      };
      try {
        await client.connect(await this.transport(), { timeout: this.options.requestTimeoutMs });
      } catch (error) {
        lastError = error;
        await client.close().catch(() => undefined);
        continue;
      }
      if (this.closed) {
        await client.close().catch(() => undefined);
        throw this.closedError();
      }
      this.client = client;
      this.tools = null;
      this.connects += 1;
      return client;
    }
    throw new McpPoolError(
      'connect_failed',
      `${this.name} sunucusuna ${maxAttempts} denemede bağlanılamadı: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      this.name,
      { cause: lastError },
    );
  }

  async listTools(refresh: boolean): Promise<Tool[]> {
    const now = this.options.now ?? Date.now;
    if (!refresh && this.tools && now() - this.tools.at < this.options.toolCacheTtlMs) return this.tools.list;
    this.listing ??= this.fetchTools(true).finally(() => {
      this.listing = null;
    });
    return this.listing;
  }

  private async fetchTools(retry: boolean): Promise<Tool[]> {
    const now = this.options.now ?? Date.now;
    try {
      const list = await this.run(async (client) => {
        const tools: Tool[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: this.options.requestTimeoutMs });
          tools.push(...page.tools);
          cursor = page.nextCursor;
        } while (cursor);
        return tools;
      });
      this.tools = { list, at: now() };
      return list;
    } catch (error) {
      if (retry && isDisconnect(error)) return this.fetchTools(false);
      throw error;
    }
  }

  callTool(name: string, args: Record<string, unknown>, options: CallOptions): Promise<CallToolResult> {
    return this.run(async (client) => {
      const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
        timeout: options.timeoutMs ?? this.options.requestTimeoutMs,
        ...(options.signal && { signal: options.signal }),
      });
      return result as CallToolResult;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.closedError());
    const pending = this.connecting;
    const client = this.client;
    this.client = null;
    this.tools = null;
    await pending?.catch(() => undefined);
    await client?.close();
  }
}

export class McpClientPool {
  private readonly connections = new Map<string, ServerConnection>();
  private closed = false;

  constructor(options: McpPoolOptions) {
    positive('maxConcurrency', options.maxConcurrency);
    positive('toolCacheTtlMs', options.toolCacheTtlMs, true);
    positive('requestTimeoutMs', options.requestTimeoutMs);
    positive('reconnect.maxAttempts', options.reconnect.maxAttempts);
    positive('reconnect.backoffMs', options.reconnect.backoffMs, true);
    positive('reconnect.maxBackoffMs', options.reconnect.maxBackoffMs, true);
    const names = Object.keys(options.servers);
    if (names.length === 0) throw new Error('en az bir MCP sunucusu gerekli');
    for (const name of names) this.connections.set(name, new ServerConnection(name, options.servers[name]!, options));
  }

  /** Havuzdaki sunucu adları. */
  servers(): string[] {
    return [...this.connections.keys()];
  }

  private connection(server: string): ServerConnection {
    if (this.closed) throw new McpPoolError('closed', 'MCP havuzu kapatıldı', server);
    const connection = this.connections.get(server);
    if (!connection) throw new McpPoolError('unknown_server', `havuzda ${server} sunucusu yok`, server);
    return connection;
  }

  /** Sunucunun tool'ları (önbellekten; `refresh` önbelleği atlar). */
  async listTools(server: string, options: { refresh?: boolean } = {}): Promise<Tool[]> {
    return this.connection(server).listTools(options.refresh ?? false);
  }

  /**
   * Bütün sunucuların tool'ları. Ulaşılamayan sunucu sonucu düşürmez; `errors`'ta sunucu adıyla döner.
   */
  async listAllTools(): Promise<{ tools: PoolTool[]; errors: { server: string; error: unknown }[] }> {
    const names = this.servers();
    const results = await Promise.allSettled(names.map((name) => this.listTools(name)));
    const tools: PoolTool[] = [];
    const errors: { server: string; error: unknown }[] = [];
    results.forEach((result, i) => {
      const server = names[i]!;
      if (result.status === 'fulfilled') tools.push(...result.value.map((tool) => ({ ...tool, server })));
      else errors.push({ server, error: result.reason });
    });
    return { tools, errors };
  }

  /** Adı verilen tool'u sunan sunucular. */
  async findTool(name: string): Promise<PoolTool[]> {
    return (await this.listAllTools()).tools.filter((tool) => tool.name === name);
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<CallToolResult> {
    return this.connection(server).callTool(name, args, options);
  }

  /** Tool'u adıyla çağırır; tool tek bir sunucuda olmalı. */
  async callToolByName(
    name: string,
    args: Record<string, unknown> = {},
    options: CallOptions = {},
  ): Promise<CallToolResult & { server: string }> {
    const matches = await this.findTool(name);
    if (matches.length === 0) throw new McpPoolError('tool_not_found', `${name} tool'u hiçbir sunucuda yok`);
    if (matches.length > 1) {
      throw new McpPoolError(
        'ambiguous_tool',
        `${name} tool'u birden çok sunucuda var: ${matches.map((tool) => tool.server).join(', ')}`,
      );
    }
    const server = matches[0]!.server;
    return { ...(await this.callTool(server, name, args, options)), server };
  }

  stats(server: string): ServerStats {
    return this.connection(server).stats();
  }

  /** Bütün bağlantıları kapatır; idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.connections.values()].map((connection) => connection.close()));
  }
}
