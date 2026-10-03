// JSON-RPC 2.0 zarfı (spec §9.3, §9.5): istek ayrıştırma, parametre doğrulama, yanıt kurma.
import { JsonRpcIdSchema, JsonRpcRequestSchema, type JsonRpcId, type JsonRpcRequest } from '@squaresdk/solana-types';
import type { z } from 'zod';
import { A2aError, errors, type FieldViolation } from './errors.js';

export type ParsedRequest = { ok: true; request: JsonRpcRequest } | { ok: false; id: JsonRpcId; error: A2aError };

export function parseJsonRpc(body: string): ParsedRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, id: null, error: errors.parse() };
  }
  const parsed = JsonRpcRequestSchema.safeParse(value);
  if (parsed.success) return { ok: true, request: parsed.data };
  const rawId =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { id?: unknown }).id : null;
  const id = JsonRpcIdSchema.safeParse(rawId);
  return {
    ok: false,
    id: id.success ? id.data : null,
    error: errors.invalidRequest(
      Array.isArray(value) ? 'toplu (batch) istek desteklenmez' : 'JSON-RPC 2.0 isteği değil',
    ),
  };
}

function violations(issues: readonly z.core.$ZodIssue[]): FieldViolation[] {
  return issues.map((issue) => ({ field: issue.path.map(String).join('.'), description: issue.message }));
}

/** Parametreleri şemayla doğrular; geçersizse `-32602` ve alan ihlalleri. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) throw errors.invalidParams(violations(parsed.error.issues));
  return parsed.data;
}

export function successResponse(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

export function errorResponse(id: JsonRpcId, error: A2aError) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) },
  };
}
