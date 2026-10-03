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

interface Node {
  value: unknown;
  depth: number;
  parent: Node | null;
  key: string | number;
}

function pathOf(node: Node): string {
  const keys: (string | number)[] = [];
  for (let current: Node | null = node; current?.parent; current = current.parent) keys.push(current.key);
  return keys.reverse().reduce<string>((path, key) => {
    if (typeof key === 'number') return `${path}[${key}]`;
    return path ? `${path}.${key}` : key;
  }, '');
}

/**
 * I-JSON (RFC 7493) denetimi: NUL, eşleşmemiş surrogate, sonlu olmayan sayı (`1e999`) ve `MAX_DEPTH`'ten
 * derin iç içe değer reddedilir. Postgres JSONB'si ve RFC 8785 kanonikleştirmesi bunları kabul etmez. Alan
 * yolu yalnızca ihlalde kurulur.
 */
export function jsonViolation(value: unknown): FieldViolation | null {
  const stack: Node[] = [{ value, depth: 0, parent: null, key: '' }];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    const current = node.value;
    if (typeof current === 'string') {
      const problem = stringProblem(current);
      if (problem) return { field: pathOf(node), description: problem };
    } else if (typeof current === 'number') {
      if (!Number.isFinite(current)) return { field: pathOf(node), description: 'sonlu olmayan sayı' };
    } else if (typeof current === 'object' && current !== null) {
      if (node.depth >= MAX_DEPTH) {
        return { field: pathOf(node), description: `iç içe derinlik ${MAX_DEPTH} sınırını aşıyor` };
      }
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          stack.push({ value: current[index], depth: node.depth + 1, parent: node, key: index });
        }
        continue;
      }
      for (const key of Object.keys(current)) {
        const child: Node = {
          value: (current as Record<string, unknown>)[key],
          depth: node.depth + 1,
          parent: node,
          key,
        };
        const problem = stringProblem(key);
        if (problem) return { field: pathOf(child), description: `anahtarda ${problem}` };
        stack.push(child);
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
