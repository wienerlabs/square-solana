import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter, rateLimitHeaders, rateLimitMiddleware, type RateLimitDecision } from '../src/rate-limit.js';
import { memoryRateLimitStore } from './memory-stores.js';

const T0 = Date.parse('2026-10-06T09:00:00Z');

describe('createRateLimiter', () => {
  it('pencerede sınıra kadar izin verir, sonra reddeder; yeni pencere sıfırdan başlar', async () => {
    let now = T0 + 10_000;
    const limiter = createRateLimiter({
      store: memoryRateLimitStore(),
      rule: { limit: 3, windowSeconds: 60 },
      clock: () => now,
    });
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.consume('api:wallet:A'));
    expect(results.map((r) => [r.allowed, r.remaining])).toEqual([
      [true, 2],
      [true, 1],
      [true, 0],
      [false, 0],
    ]);
    expect(results[3]).toMatchObject({ retryAfterSeconds: 50, resetAt: new Date(T0 + 60_000) });
    expect((await limiter.consume('api:wallet:B')).allowed).toBe(true);
    now = T0 + 60_000;
    expect(await limiter.consume('api:wallet:A')).toMatchObject({ allowed: true, remaining: 2 });
    expect((await limiter.consume('api:wallet:A', 3)).allowed).toBe(false);
  });

  it('parametreleri doğrular', async () => {
    const store = memoryRateLimitStore();
    expect(() => createRateLimiter({ store, rule: { limit: 0, windowSeconds: 60 } })).toThrow(/limit/);
    expect(() => createRateLimiter({ store, rule: { limit: 1, windowSeconds: 0.5 } })).toThrow(/windowSeconds/);
    const limiter = createRateLimiter({ store, rule: { limit: 1, windowSeconds: 1 } });
    await expect(limiter.consume('')).rejects.toThrow(/boş/);
    await expect(limiter.consume('k', 0)).rejects.toThrow(/cost/);
  });
});

describe('rate limit headers and middleware', () => {
  const decision = (allowed: boolean): RateLimitDecision => ({
    allowed,
    limit: 10,
    remaining: allowed ? 4 : 0,
    resetAt: new Date(T0 + 30_000),
    retryAfterSeconds: allowed ? 0 : 30,
  });

  it('IETF taslağındaki başlıklar; reddedilende Retry-After', () => {
    expect(rateLimitHeaders(decision(true), T0)).toEqual({
      'RateLimit-Limit': '10',
      'RateLimit-Remaining': '4',
      'RateLimit-Reset': '30',
    });
    expect(rateLimitHeaders(decision(false), T0)).toMatchObject({ 'Retry-After': '30' });
  });

  it('izin verilen istek geçer, reddedilen reject alır, anahtarsız istek sınırlanmaz, depo hatası iletilir', async () => {
    const limiter = createRateLimiter({ store: memoryRateLimitStore(), rule: { limit: 1, windowSeconds: 60 } });
    const reject = vi.fn();
    const middleware = rateLimitMiddleware<
      { key: string | null },
      { set: (n: string, v: string) => void; headers: Record<string, string> }
    >({
      limiter,
      keyOf: (req) => req.key,
      reject: (_req, res, d) => reject(res.headers, d.allowed),
    });
    const run = (key: string | null) =>
      new Promise<{ next: unknown; headers: Record<string, string> }>((resolve) => {
        const headers: Record<string, string> = {};
        const res = { set: (n: string, v: string) => void (headers[n] = v), headers };
        middleware({ key }, res, (error) => resolve({ next: error ?? 'next', headers }));
        setTimeout(() => resolve({ next: 'rejected', headers }), 50);
      });
    expect(await run('k')).toMatchObject({ next: 'next', headers: { 'RateLimit-Remaining': '0' } });
    expect((await run('k')).next).toBe('rejected');
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ 'Retry-After': expect.any(String) }), false);
    expect((await run(null)).next).toBe('next');

    const failing = rateLimitMiddleware<object, { set(): void }>({
      limiter: { consume: () => Promise.reject(new Error('db down')) },
      keyOf: () => 'k',
      reject: () => undefined,
    });
    const error = await new Promise((resolve) => failing({}, { set: () => undefined }, resolve));
    expect(error).toEqual(new Error('db down'));
  });
});
