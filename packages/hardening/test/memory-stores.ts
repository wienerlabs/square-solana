// Test fikstürü: depo arayüzlerinin bellek içi uygulamaları (saf modüllerin testleri için). Postgres
// uygulaması `prisma-store.test.ts`'te gerçek veritabanıyla sınanır.
import type { IdempotencyBegin, IdempotencyStore, RateLimitStore, ReplayStore } from '../src/stores.js';

export function memoryReplayStore(): ReplayStore & { size(): number } {
  const seen = new Map<string, number>();
  return {
    async claim(scope, id, expiresAt, now) {
      const key = `${scope}\u0000${id}`;
      const until = seen.get(key);
      if (until !== undefined && until > now.getTime()) return false;
      seen.set(key, expiresAt.getTime());
      return true;
    },
    size: () => seen.size,
  };
}

export function memoryRateLimitStore(): RateLimitStore {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async hit(key, windowStart, cost) {
      const current = windows.get(key);
      const next =
        current && current.start >= windowStart.getTime()
          ? { start: current.start, count: current.count + cost }
          : { start: windowStart.getTime(), count: cost };
      windows.set(key, next);
      return next.count;
    },
  };
}

interface Record {
  hash: string;
  state: 'in_progress' | 'completed';
  status?: number;
  body?: unknown;
  expiresAt: number;
}

export function memoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, Record>();
  const id = (scope: string, key: string) => `${scope}\u0000${key}`;
  return {
    async begin(scope, key, requestHash, expiresAt, now): Promise<IdempotencyBegin> {
      const current = records.get(id(scope, key));
      if (!current || current.expiresAt <= now.getTime()) {
        records.set(id(scope, key), { hash: requestHash, state: 'in_progress', expiresAt: expiresAt.getTime() });
        return { state: 'started' };
      }
      if (current.hash !== requestHash) return { state: 'mismatch' };
      if (current.state === 'in_progress') return { state: 'in_progress' };
      return { state: 'completed', status: current.status!, body: current.body };
    },
    async complete(scope, key, status, body) {
      const current = records.get(id(scope, key));
      if (current?.state === 'in_progress')
        records.set(id(scope, key), { ...current, state: 'completed', status, body });
    },
    async abandon(scope, key) {
      if (records.get(id(scope, key))?.state === 'in_progress') records.delete(id(scope, key));
    },
  };
}
