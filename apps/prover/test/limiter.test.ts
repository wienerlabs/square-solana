import { describe, expect, it } from 'vitest';
import { CapacityError, createLimiter } from '../src/limiter.js';

/** Dışarıdan bitirilen iş. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, task: () => opened.then(() => 'bitti') };
}

describe('createLimiter', () => {
  it('sınır kadar işi aynı anda çalıştırır, fazlasını sırayla', async () => {
    const limiter = createLimiter({ maxConcurrent: 2, maxQueue: 2, queueTimeoutMs: 10_000 });
    const gates = [gate(), gate(), gate(), gate()];
    const order: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(i);
        return g.task();
      }),
    );
    await Promise.resolve();
    expect(limiter.stats()).toEqual({ active: 2, queued: 2 });
    expect(limiter.hasCapacity()).toBe(false);
    gates[0]!.open();
    await runs[0];
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([0, 1, 2]);
    expect(limiter.stats()).toEqual({ active: 2, queued: 1 });
    gates.forEach((g) => g.open());
    expect(await Promise.all(runs)).toEqual(['bitti', 'bitti', 'bitti', 'bitti']);
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
    expect(limiter.hasCapacity()).toBe(true);
  });

  it('sıra doluysa hemen reddeder', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 10_000 });
    const g = gate();
    const first = limiter.run(g.task);
    await expect(limiter.run(g.task)).rejects.toMatchObject({ name: 'CapacityError', reason: 'queue_full' });
    g.open();
    await first;
  });

  it('sırada bekleme süresi dolunca reddeder ve sıradan çıkarır', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 20 });
    const g = gate();
    const first = limiter.run(g.task);
    const waiting = limiter.run(g.task);
    await expect(waiting).rejects.toBeInstanceOf(CapacityError);
    await expect(waiting).rejects.toMatchObject({ reason: 'queue_timeout' });
    expect(limiter.stats()).toEqual({ active: 1, queued: 0 });
    g.open();
    await first;
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });

  it('hata veren iş yuvayı bırakır', async () => {
    const limiter = createLimiter({ maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 10_000 });
    await expect(limiter.run(() => Promise.reject(new Error('iş hatası')))).rejects.toThrow('iş hatası');
    expect(limiter.stats()).toEqual({ active: 0, queued: 0 });
  });
});
