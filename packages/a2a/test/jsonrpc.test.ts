import { GetTaskRequestSchema } from '@squaresdk/solana-types';
import { describe, expect, it } from 'vitest';
import { A2aError, BAD_REQUEST_TYPE, ERROR_INFO_TYPE, errors } from '../src/errors.js';
import { errorResponse, parseJsonRpc, parseParams, successResponse } from '../src/jsonrpc.js';

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
