import { GetTaskRequestSchema } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { A2aError, BAD_REQUEST_TYPE, ERROR_INFO_TYPE, errors } from '../src/errors.js';
import {
  errorResponse,
  exceedsDepth,
  jsonViolation,
  parseJsonRpc,
  parseParams,
  successResponse,
} from '../src/jsonrpc.js';

describe('parseJsonRpc', () => {
  it('geçerli isteği ayrıştırır', () => {
    const parsed = parseJsonRpc('{"jsonrpc":"2.0","id":7,"method":"GetTask","params":{"id":"t"}}');
    expect(parsed).toEqual({ ok: true, request: { jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: 't' } } });
  });

  it('JSON değilse -32700 ve id null', () => {
    const parsed = parseJsonRpc('{"jsonrpc":');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.id).toBeNull();
    expect(parsed.error.code).toBe(-32700);
  });

  it('zarf geçersizse -32600; okunabilen id korunur', () => {
    const parsed = parseJsonRpc('{"jsonrpc":"1.0","id":"x","method":"GetTask"}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.id).toBe('x');
    expect(parsed.error.code).toBe(-32600);
  });

  it('dizi (batch) istekleri desteklenmez: -32600', () => {
    const parsed = parseJsonRpc('[{"jsonrpc":"2.0","id":1,"method":"GetTask"}]');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(-32600);
  });
});

describe('parseParams', () => {
  it('geçerli parametreleri döner', () => {
    expect(parseParams(GetTaskRequestSchema, { id: 't', historyLength: 2 })).toEqual({ id: 't', historyLength: 2 });
  });

  it('geçersiz parametrede -32602 ve BadRequest alan ihlalleri', () => {
    try {
      parseParams(GetTaskRequestSchema, { historyLength: -1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(A2aError);
      const e = error as A2aError;
      expect(e.code).toBe(-32602);
      const detail = e.data?.find((d) => d['@type'] === BAD_REQUEST_TYPE) as unknown as {
        fieldViolations: { field: string }[];
      };
      expect(detail.fieldViolations.map((v) => v.field).sort()).toEqual(['historyLength', 'id']);
    }
  });
});

describe('yanıtlar', () => {
  it('başarılı yanıt', () => {
    expect(successResponse(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('hata yanıtı ErrorInfo ayrıntısıyla', () => {
    const response = errorResponse('a', errors.taskNotCancelable('TASK_STATE_COMPLETED'));
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'a',
      error: {
        code: -32002,
        message: 'Task cannot be canceled',
        data: [
          {
            '@type': ERROR_INFO_TYPE,
            reason: 'TASK_NOT_CANCELABLE',
            domain: 'squaresdk.solana',
            metadata: { state: 'TASK_STATE_COMPLETED' },
          },
        ],
      },
    });
  });

  it('iç hata ayrıntı sızdırmaz', () => {
    expect(errorResponse(null, errors.internal())).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  });
});

describe('jsonViolation (I-JSON, RFC 7493)', () => {
  it('geçerli değerde ihlal yok', () => {
    expect(jsonViolation({ a: [1, 'iki', { c: null, d: true }], ğ: 'ü😀' })).toBeNull();
  });

  it('NUL, eşleşmemiş surrogate, sonlu olmayan sayı ve aşırı derinlik alan yoluyla döner', () => {
    expect(jsonViolation({ message: { parts: [{ text: 'a\u0000' }] } })?.field).toBe('message.parts[0].text');
    expect(jsonViolation({ x: ['\udc00'] })?.field).toBe('x[0]');
    expect(jsonViolation({ ['k\u0000']: 1 })?.field).toBe('k\u0000');
    expect(jsonViolation({ n: Number.POSITIVE_INFINITY })?.field).toBe('n');
    expect(jsonViolation({ n: Number.NaN })).not.toBeNull();
    let deep: unknown = 0;
    for (let i = 0; i < 65; i += 1) deep = [deep];
    expect(jsonViolation({ deep })?.description).toMatch(/derinlik/);
  });

  it('parseParams ihlali -32602 olarak döner', () => {
    const error = (() => {
      try {
        parseParams(GetTaskRequestSchema, { id: 'a\u0000' });
      } catch (e) {
        return e as A2aError;
      }
      return null;
    })();
    expect(error?.code).toBe(-32602);
  });
});

describe('exceedsDepth', () => {
  it('dizgi içindeki parantezleri ve kaçışları saymaz', () => {
    expect(exceedsDepth('[[[]]]', 3)).toBe(false);
    expect(exceedsDepth('[[[[]]]]', 3)).toBe(true);
    expect(exceedsDepth('{"a":"[[[[[[","b":[1]}', 2)).toBe(false);
    expect(exceedsDepth('{"a":"\\"[[[[","b":{"c":{}}}', 2)).toBe(true);
    expect(exceedsDepth('"[[[[[["', 1)).toBe(false);
  });
});
