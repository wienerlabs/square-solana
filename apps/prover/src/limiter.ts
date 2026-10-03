// Eşzamanlılık sınırı: en fazla `maxConcurrent` ispat aynı anda üretilir; fazlası `maxQueue`'ya kadar
// sırada en çok `queueTimeoutMs` bekler. Sıra doluysa ya da bekleme süresi dolarsa istek
// `CapacityError` ile reddedilir (HTTP 503). Proving bellek ve CPU yoğundur; sınır servisi korur.
import type { LimiterConfig } from './config.js';

export class CapacityError extends Error {
  override readonly name = 'CapacityError';
  constructor(readonly reason: 'queue_full' | 'queue_timeout') {
    super(reason === 'queue_full' ? 'prover dolu: sıra kapasitesi aşıldı' : 'prover dolu: sırada bekleme süresi doldu');
  }
}

export interface LimiterStats {
  readonly active: number;
  readonly queued: number;
}

export interface Limiter {
  run<T>(task: () => Promise<T>): Promise<T>;
  stats(): LimiterStats;
  /** Yeni istek sıraya girebilir mi (hazırlık kontrolü). */
  hasCapacity(): boolean;
}

interface Waiter {
  readonly start: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export function createLimiter(config: LimiterConfig): Limiter {
  let active = 0;
  let queue: readonly Waiter[] = [];

  const release = () => {
    const [next, ...rest] = queue;
    queue = rest;
    if (next) {
      clearTimeout(next.timer);
      next.start();
    } else {
      active -= 1;
    }
  };

  const acquire = () =>
    new Promise<void>((resolve, reject) => {
      if (active < config.maxConcurrent) {
        active += 1;
        resolve();
        return;
      }
      if (queue.length >= config.maxQueue) {
        reject(new CapacityError('queue_full'));
        return;
      }
      const waiter: Waiter = {
        // Sıradaki iş, çıkan işin yuvasını devralır; `active` değişmez.
        start: resolve,
        timer: setTimeout(() => {
          queue = queue.filter((w) => w !== waiter);
          reject(new CapacityError('queue_timeout'));
        }, config.queueTimeoutMs),
      };
      queue = [...queue, waiter];
    });

  return {
    async run(task) {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
    stats: () => ({ active, queued: queue.length }),
    hasCapacity: () => active < config.maxConcurrent || queue.length < config.maxQueue,
  };
}
