import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createIdempotency, IdempotencyError, requestHash } from '../src/idempotency.js';
import { memoryIdempotencyStore } from './memory-stores.js';

const KEY = randomUUID();
const request = { method: 'POST', path: '/v1/tx', body: { call: 'listClaim', price: '225' } };

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
    return 'tamam';
  } catch (error) {
    if (error instanceof IdempotencyError) return error.reason;
    throw error;
  }
}

describe('createIdempotency', () => {
  it('ilk istek işlenir, tekrarı kaydedilen yanıtı alır', async () => {
    const idem = createIdempotency({ store: memoryIdempotencyStore(), ttlSeconds: 3600 });
    const handler = vi.fn(async () => ({ status: 201, body: { id: 'tx-1' } }));
    expect(await idem.run({ scope: 'api:A', key: KEY, request, handler })).toEqual({
      status: 201,
      body: { id: 'tx-1' },
      replayed: false,
    });
    expect(await idem.run({ scope: 'api:A', key: KEY, request, handler })).toEqual({
      status: 201,
      body: { id: 'tx-1' },
      replayed: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    // Başka bir istemcinin aynı anahtarı ayrı bir kayıttır.
    await idem.run({ scope: 'api:B', key: KEY, request, handler });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('aynı anahtar başka istekle kullanılamaz; süren istek tekrarı reddedilir', async () => {
    const idem = createIdempotency({ store: memoryIdempotencyStore(), ttlSeconds: 3600 });
    let release!: () => void;
    const slow = idem.run({
      scope: 's',
      key: KEY,
      request,
      handler: () => new Promise((resolve) => (release = () => resolve({ status: 200, body: 'ok' }))),
    });
    await Promise.resolve();
    expect(
      await reason(idem.run({ scope: 's', key: KEY, request, handler: async () => ({ status: 200, body: 'x' }) })),
    ).toBe('in_progress');
    release();
    await slow;
    const other = { ...request, body: { ...request.body, price: '226' } };
    expect(
      await reason(
        idem.run({ scope: 's', key: KEY, request: other, handler: async () => ({ status: 200, body: 'x' }) }),
      ),
    ).toBe('mismatch');
    expect(
      await reason(idem.run({ scope: 's', key: 'kısa', request, handler: async () => ({ status: 200, body: 'x' }) })),
    ).toBe('invalid_key');
  });

  it('hata ve 5xx kaydedilmez; istemci yeniden deneyebilir', async () => {
    const idem = createIdempotency({ store: memoryIdempotencyStore(), ttlSeconds: 3600 });
    await expect(
      idem.run({ scope: 's', key: KEY, request, handler: async () => Promise.reject(new Error('rpc down')) }),
    ).rejects.toThrow('rpc down');
    expect(
      await idem.run({ scope: 's', key: KEY, request, handler: async () => ({ status: 503, body: 'busy' }) }),
    ).toMatchObject({ status: 503, replayed: false });
    expect(
      await idem.run({ scope: 's', key: KEY, request, handler: async () => ({ status: 200, body: 'ok' }) }),
    ).toMatchObject({ status: 200, replayed: false });
  });

  it('süre dolunca anahtar yeniden kullanılabilir; özet anahtar sırasından bağımsız', async () => {
    let now = Date.parse('2026-10-06T09:00:00Z');
    const idem = createIdempotency({ store: memoryIdempotencyStore(), ttlSeconds: 60, clock: () => now });
    const handler = vi.fn(async () => ({ status: 200, body: 'ok' }));
    await idem.run({ scope: 's', key: KEY, request, handler });
    now += 61_000;
    expect((await idem.run({ scope: 's', key: KEY, request, handler })).replayed).toBe(false);
    expect(requestHash({ a: 1, b: [2, { c: 3, d: undefined }] })).toBe(requestHash({ b: [2, { c: 3 }], a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
    expect(() => createIdempotency({ store: memoryIdempotencyStore(), ttlSeconds: 0 })).toThrow(/ttlSeconds/);
  });
});
