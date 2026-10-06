// Capability başına çalıştırma bağlamı (izolasyon, README "Çalışma zamanı izolasyonu", ADR 0022). Her capability'nin:
// - kendi MCP havuzu vardır ve havuzda yalnızca allowlist'inin sunucuları bulunur: bir capability'nin bağlantıları,
//   kuyruğu ya da asılı kalan sunucusu diğerini etkilemez;
// - tool allowlist'i (tools.ts, claude.ts), zaman, istek ve token sınırları vardır;
// - eşzamanlılık sınırı ve sınırlı bekleme kuyruğu vardır; kuyruk doluysa iş hemen düşer;
// - hatası kendi çalıştırmasında kalır: istisna yalnızca o görevi FAILED yapar, sayaçlara yazılır, diğer
//   capability'ler ve agent sürer.
import type Anthropic from '@anthropic-ai/sdk';
import type { JobRequest } from '@squaresdk/solana-agent-sdk';
import type { McpClientPool } from '@squaresdk/solana-mcp/client';
import { runClaude, type MessagesClient, type ToolCallRecord } from './claude.js';
import type { CapabilityConfig } from './config.js';
import { resolveMcpTools, type LocalTool } from './tools.js';

/** Capability'nin kuyruğu dolu ya da çalıştırma kapatıldı. */
export class CapabilityBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityBusyError';
  }
}

/** Çalıştırma zaman sınırını aştı. */
export class CapabilityTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityTimeoutError';
  }
}

export interface RuntimeStats {
  active: number;
  queued: number;
  completed: number;
  failed: number;
  /** Kuyruk dolu olduğu için hemen düşen işler. */
  rejected: number;
  /** Allowlist dışı tool denemeleri. */
  deniedToolCalls: number;
}

export interface CapabilityRuntimeOptions {
  capability: CapabilityConfig;
  /** Yalnızca bu capability'nin sunucularını içeren havuz; tool'u yoksa null. */
  pool: McpClientPool | null;
  client: MessagesClient;
  /** Hosted agent'ın eklediği tool'lar (ör. delegasyon). */
  extraTools?: readonly LocalTool[];
  /** İşten Claude'a giden kullanıcı mesajı; verilmezse spec'in `input` metni, yoksa spec'in JSON'u. */
  prompt?: (request: JobRequest) => string;
  onToolCall?: (capability: string, call: ToolCallRecord) => void;
}

function defaultPrompt(request: JobRequest): string {
  const { spec } = request;
  if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
    const input = (spec as Record<string, unknown>).input;
    if (typeof input === 'string' && input.trim().length > 0) return input;
  }
  return JSON.stringify(spec);
}

export class CapabilityRuntime {
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private readonly counters = { completed: 0, failed: 0, rejected: 0, deniedToolCalls: 0 };
  private closed = false;

  constructor(private readonly options: CapabilityRuntimeOptions) {}

  get id(): string {
    return this.options.capability.id;
  }

  stats(): RuntimeStats {
    return { active: this.active, queued: this.waiters.length, ...this.counters };
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    const { maxConcurrency, maxQueue } = this.options.capability.limits;
    if (this.closed) throw new CapabilityBusyError(`${this.id}: çalıştırma kapatıldı`);
    if (this.active < maxConcurrency) {
      this.active += 1;
      return;
    }
    if (this.waiters.length >= maxQueue) {
      this.counters.rejected += 1;
      throw new CapabilityBusyError(`${this.id}: eşzamanlılık sınırı (${maxConcurrency}) ve kuyruk (${maxQueue}) dolu`);
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    // Sıradaki iş yuvayı devralır; `active` değişmez.
    if (next) next.resolve();
    else this.active -= 1;
  }

  /** Allowlist'teki MCP tool'ları ve ek tool'lar. */
  async tools(): Promise<LocalTool[]> {
    const { capability, pool } = this.options;
    const mcp = pool
      ? await resolveMcpTools(pool, capability.tools, {
          maxResultBytes: capability.limits.maxToolResultBytes,
          timeoutMs: capability.limits.timeoutMs,
        })
      : [];
    return [...mcp, ...(this.options.extraTools ?? [])];
  }

  /** İşi yürütür: slot bekler, zaman sınırını kurar, Claude'u izinli tool'larla çalıştırır. */
  async run(request: JobRequest): Promise<{ content: string; contentType: string }> {
    const { capability } = this.options;
    request.signal.throwIfAborted();
    await this.acquire(request.signal);
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(new CapabilityTimeoutError(`${this.id}: ${capability.limits.timeoutMs} ms zaman sınırı aşıldı`)),
      capability.limits.timeoutMs,
    );
    const signal = AbortSignal.any([request.signal, timeout.signal]);
    try {
      const result = await runClaude({
        client: this.options.client,
        model: capability.model,
        system: capability.instructions,
        ...(capability.effort && { effort: capability.effort as Anthropic.OutputConfig['effort'] }),
        prompt: (this.options.prompt ?? defaultPrompt)(request),
        tools: await this.tools(),
        maxTokens: capability.limits.maxTokens,
        maxTurns: capability.limits.maxTurns,
        maxTotalTokens: capability.limits.maxTotalTokens,
        signal,
        onToolCall: (call) => {
          if (call.outcome === 'denied') this.counters.deniedToolCalls += 1;
          this.options.onToolCall?.(this.id, call);
        },
      });
      this.counters.completed += 1;
      return { content: result.text, contentType: capability.contentType };
    } catch (error) {
      this.counters.failed += 1;
      // Zaman aşımında SDK'nın iptal hatası yerine sebep.
      if (timeout.signal.aborted && !request.signal.aborted) throw timeout.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      this.release();
    }
  }

  /** Kuyruktakileri reddeder ve havuzu kapatır. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new CapabilityBusyError(`${this.id}: kapatıldı`));
    await this.options.pool?.close();
  }
}
