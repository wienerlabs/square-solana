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

const MAX_DEPTH = 64;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const stringProblem = (value: string) =>
  value.includes('\u0000') ? 'NUL karakteri' : LONE_SURROGATE.test(value) ? 'eşleşmemiş UTF-16 surrogate' : null;

/**
 * I-JSON (RFC 7493) denetimi: NUL, eşleşmemiş surrogate, sonlu olmayan sayı (`1e999`) ve `MAX_DEPTH`'ten
 * derin iç içe değer reddedilir. Postgres JSONB'si ve RFC 8785 kanonikleştirmesi bunları kabul etmez.
 */
export function jsonViolation(value: unknown): FieldViolation | null {
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: '', depth: 0 }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value: current, path, depth } = item;
    if (typeof current === 'string') {
      const problem = stringProblem(current);
      if (problem) return { field: path, description: problem };
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { field: path, description: 'sonlu olmayan sayı' };
    } else if (typeof current === 'object' && current !== null) {
      if (depth >= MAX_DEPTH) return { field: path, description: `iç içe derinlik ${MAX_DEPTH} sınırını aşıyor` };
      if (Array.isArray(current)) {
        current.forEach((child, index) => stack.push({ value: child, path: `${path}[${index}]`, depth: depth + 1 }));
        continue;
      }
      for (const [key, child] of Object.entries(current)) {
        const childPath = path ? `${path}.${key}` : key;
        const problem = stringProblem(key);
        if (problem) return { field: childPath, description: `anahtarda ${problem}` };
        stack.push({ value: child, path: childPath, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** Parametreleri I-JSON'a ve şemaya göre doğrular; geçersizse `-32602` ve alan ihlalleri. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const violation = jsonViolation(params);
  if (violation) throw errors.invalidParams([violation]);
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
