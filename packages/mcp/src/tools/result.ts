// Tool sonuçları ve ortak bağlam. Sonuç gövdesi JSON metnidir (Covenant MCP'deki gibi); agent'a dönen metinler
// apps/web arayüzü gibi İngilizcedir. API hataları kodu ve zincir hatasıyla (`programError`) aynen taşınır.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import { SquareApiError } from '../api.js';
import type { SquareChain } from '../chain.js';
import { UnsignedTransactionError, type LocalSigner } from '../transactions.js';

export interface ToolContext {
  network: string;
  api: SquareApi;
  /** Yazma kipi kapalıysa null. */
  write: { chain: SquareChain; signer: LocalSigner | null } | null;
}

/** Tool'un agent'a açıkladığı kullanıcı hatası (eksik girdi, yanlış job durumu …). */
export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ToolInputError';
  }
}

const json = (data: unknown) =>
  JSON.stringify(data, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: json(data) }] };
}

export function fail(error: unknown): CallToolResult {
  let body: Record<string, unknown>;
  if (error instanceof SquareApiError) {
    body = {
      error: 'square_api_error',
      code: error.code,
      message: error.message,
      programError: error.programError,
      details: error.details,
    };
  } else if (error instanceof UnsignedTransactionError) {
    body = { error: 'not_fully_signed', message: error.message, signatures: error.signatures };
  } else if (error instanceof ToolInputError) {
    body = { error: 'invalid_request', message: error.message, ...(error.details ? { details: error.details } : {}) };
  } else {
    body = { error: 'internal_error', message: error instanceof Error ? error.message : String(error) };
  }
  return { content: [{ type: 'text', text: json(body) }], isError: true };
}

/** Tool gövdesini hata yakalamayla sarar. */
export function guarded<A>(handler: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await handler(args));
    } catch (error) {
      return fail(error);
    }
  };
}

/** Unix saniyesi → ISO 8601; 0 (atanmamış) null. */
export const iso = (seconds: number | null): string | null =>
  seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;

const ZERO32 = '0'.repeat(64);
/** Sıfır hash'i (atanmamış) null. */
export const hash = (hex: string): string | null => (hex === ZERO32 ? null : hex);
