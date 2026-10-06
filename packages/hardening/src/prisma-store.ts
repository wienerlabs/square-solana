// Kalıcı depoların Postgres uygulaması (`rate_limit_windows`, `idempotency_records`, `replay_guards`;
// db/prisma/schema.prisma, BE-13). Her işlem tek bir SQL ifadesiyle atomiktir; eşzamanlı istekler ve
// servisin birden çok örneği aynı satırlarda yarışmaz. db paketine yalnızca tip olarak bağlıdır; istemci
// (`createDatabaseClient`) çağırandan gelir.
import type { PrismaClient } from '@squaresdk/solana-db';
import type { ExpiringStore, IdempotencyBegin, IdempotencyStore, RateLimitStore, ReplayStore } from './stores.js';

export function createPrismaReplayStore(client: PrismaClient): ReplayStore & ExpiringStore {
  return {
    async claim(scope, id, expiresAt, now) {
      // Süresi dolmamış kimlik varsa DO UPDATE koşulu tutmaz ve satır dönmez: tekrar oynatma.
      const rows = await client.$queryRaw<{ id: string }[]>`
        INSERT INTO replay_guards (scope, id, expires_at) VALUES (${scope}, ${id}, ${expiresAt})
        ON CONFLICT (scope, id) DO UPDATE SET expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP
          WHERE replay_guards.expires_at <= ${now}
        RETURNING id`;
      return rows.length === 1;
    },
    purgeExpired: (now) => client.$executeRaw`DELETE FROM replay_guards WHERE expires_at <= ${now}`,
  };
}

export function createPrismaRateLimitStore(client: PrismaClient): RateLimitStore & ExpiringStore {
  return {
    async hit(key, windowStart, cost, expiresAt) {
      // Yeni pencere sayacı sıfırlar; geç gelen (eski pencereli) istek güncel pencereye sayılır.
      const rows = await client.$queryRaw<{ count: number }[]>`
        INSERT INTO rate_limit_windows (key, window_start, count, expires_at)
        VALUES (${key}, ${windowStart}, ${cost}, ${expiresAt})
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN EXCLUDED.window_start > rate_limit_windows.window_start
                       THEN EXCLUDED.count ELSE rate_limit_windows.count + EXCLUDED.count END,
          window_start = GREATEST(rate_limit_windows.window_start, EXCLUDED.window_start),
          expires_at = GREATEST(rate_limit_windows.expires_at, EXCLUDED.expires_at)
        RETURNING count`;
      return Number(rows[0]!.count);
    },
    purgeExpired: (now) => client.$executeRaw`DELETE FROM rate_limit_windows WHERE expires_at <= ${now}`,
  };
}

interface IdempotencyRow {
  request_hash: string;
  state: 'in_progress' | 'completed';
  status: number | null;
  body: unknown;
}

export function createPrismaIdempotencyStore(client: PrismaClient): IdempotencyStore & ExpiringStore {
  const begin = async (
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: Date,
    now: Date,
    attempt = 0,
  ): Promise<IdempotencyBegin> => {
    // Yeni ya da süresi dolmuş anahtar bu istek için ayrılır.
    const started = await client.$queryRaw<{ key: string }[]>`
      INSERT INTO idempotency_records (scope, key, request_hash, state, expires_at)
      VALUES (${scope}, ${key}, ${requestHash}, 'in_progress'::"IdempotencyState", ${expiresAt})
      ON CONFLICT (scope, key) DO UPDATE SET
        request_hash = EXCLUDED.request_hash, state = EXCLUDED.state, status = NULL, body = NULL,
        created_at = CURRENT_TIMESTAMP, expires_at = EXCLUDED.expires_at
        WHERE idempotency_records.expires_at <= ${now}
      RETURNING key`;
    if (started.length === 1) return { state: 'started' };
    const [row] = await client.$queryRaw<IdempotencyRow[]>`
      SELECT request_hash, state::text AS state, status, body FROM idempotency_records
      WHERE scope = ${scope} AND key = ${key}`;
    // Satır iki ifade arasında silindiyse (bırakılan anahtar) bir kez daha denenir.
    if (!row) {
      if (attempt > 0) throw new Error('idempotency kaydı ayrılamadı');
      return begin(scope, key, requestHash, expiresAt, now, attempt + 1);
    }
    if (row.request_hash !== requestHash) return { state: 'mismatch' };
    if (row.state === 'in_progress') return { state: 'in_progress' };
    return { state: 'completed', status: row.status!, body: row.body };
  };
  return {
    begin: (scope, key, requestHash, expiresAt, now) => begin(scope, key, requestHash, expiresAt, now),
    async complete(scope, key, status, body) {
      await client.$executeRaw`
        UPDATE idempotency_records SET state = 'completed'::"IdempotencyState", status = ${status},
          body = ${JSON.stringify(body ?? null)}::jsonb
        WHERE scope = ${scope} AND key = ${key} AND state = 'in_progress'::"IdempotencyState"`;
    },
    async abandon(scope, key) {
      await client.$executeRaw`
        DELETE FROM idempotency_records
        WHERE scope = ${scope} AND key = ${key} AND state = 'in_progress'::"IdempotencyState"`;
    },
    purgeExpired: (now) => client.$executeRaw`DELETE FROM idempotency_records WHERE expires_at <= ${now}`,
  };
}
