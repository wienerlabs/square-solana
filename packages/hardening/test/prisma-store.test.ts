// Postgres depoları gerçek veritabanında (Testcontainers; Docker gerekir): atomiklik, eşzamanlılık, süre
// ve temizlik; idempotency, hız sınırı ve webhook tekrar koruması uçtan uca.
import { randomUUID } from 'node:crypto';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createIdempotency } from '../src/idempotency.js';
import {
  createPrismaIdempotencyStore,
  createPrismaRateLimitStore,
  createPrismaReplayStore,
} from '../src/prisma-store.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { generateWebhookSecret, signWebhook, verifyWebhook, WebhookVerificationError } from '../src/webhook.js';

let db: IsolatedDatabase;
beforeAll(async () => {
  db = await startIsolatedDatabase();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.truncate();
});

const T0 = Date.parse('2026-10-06T09:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('replay store', () => {
  it('kimliği süresi dolana kadar bir kez kabul eder; eşzamanlı isteklerden yalnızca biri geçer', async () => {
    const store = createPrismaReplayStore(db.client);
    expect(await store.claim('webhook', 'msg_1', at(300), at(0))).toBe(true);
    expect(await store.claim('webhook', 'msg_1', at(310), at(10))).toBe(false);
    expect(await store.claim('başka', 'msg_1', at(300), at(0))).toBe(true);
    expect(await store.claim('webhook', 'msg_1', at(700), at(301))).toBe(true);
    const racers = await Promise.all(Array.from({ length: 12 }, () => store.claim('webhook', 'msg_2', at(300), at(0))));
    expect(racers.filter(Boolean)).toHaveLength(1);
    expect(await store.purgeExpired(at(1000))).toBe(3);
  });

  it('webhook tekrarı uçtan uca reddedilir', async () => {
    const replay = createPrismaReplayStore(db.client);
    const secret = generateWebhookSecret();
    const payload = '{"type":"job.released"}';
    const headers = signWebhook({ secret, id: 'msg_e2e', timestamp: T0 / 1000, payload });
    const verify = () =>
      verifyWebhook({
        secrets: [secret],
        headers,
        payload,
        toleranceSeconds: 300,
        replay,
        scope: 'square',
        now: at(5),
      });
    await expect(verify()).resolves.toMatchObject({ id: 'msg_e2e' });
    await expect(verify()).rejects.toMatchObject({ reason: 'replayed' } satisfies Partial<WebhookVerificationError>);
  });
});

describe('rate limit store', () => {
  it('pencereyi sayar, yeni pencerede sıfırlar; eşzamanlı istekler kaybolmaz', async () => {
    const store = createPrismaRateLimitStore(db.client);
    expect(await store.hit('api:A', at(0), 1, at(60))).toBe(1);
    expect(await store.hit('api:A', at(0), 2, at(60))).toBe(3);
    // Geç gelen eski pencereli istek güncel pencereye sayılır.
    expect(await store.hit('api:A', at(60), 1, at(120))).toBe(1);
    expect(await store.hit('api:A', at(0), 1, at(60))).toBe(2);
    const counts = await Promise.all(Array.from({ length: 20 }, () => store.hit('api:B', at(0), 1, at(60))));
    expect(Math.max(...counts)).toBe(20);
    expect(new Set(counts).size).toBe(20);
    expect(await store.purgeExpired(at(61))).toBe(1);
  });

  it('sınırlayıcıyla birlikte servis örnekleri arasında paylaşılır', async () => {
    const rule = { limit: 2, windowSeconds: 60 };
    const instanceA = createRateLimiter({ store: createPrismaRateLimitStore(db.client), rule, clock: () => T0 });
    const instanceB = createRateLimiter({ store: createPrismaRateLimitStore(db.client), rule, clock: () => T0 });
    expect((await instanceA.consume('api:wallet:X')).allowed).toBe(true);
    expect((await instanceB.consume('api:wallet:X')).allowed).toBe(true);
    expect((await instanceA.consume('api:wallet:X')).allowed).toBe(false);
  });
});

describe('idempotency store', () => {
  it('ayırma, tamamlama, bırakma, uyuşmazlık ve süre', async () => {
    const store = createPrismaIdempotencyStore(db.client);
    expect(await store.begin('s', 'k1', HASH_A, at(3600), at(0))).toEqual({ state: 'started' });
    expect(await store.begin('s', 'k1', HASH_A, at(3600), at(1))).toEqual({ state: 'in_progress' });
    expect(await store.begin('s', 'k1', HASH_B, at(3600), at(1))).toEqual({ state: 'mismatch' });
    await store.complete('s', 'k1', 201, { id: 'tx-1', list: [1, 2] });
    expect(await store.begin('s', 'k1', HASH_A, at(3600), at(2))).toEqual({
      state: 'completed',
      status: 201,
      body: { id: 'tx-1', list: [1, 2] },
    });
    expect(await store.begin('s', 'k1', HASH_B, at(7200), at(3601))).toEqual({ state: 'started' });
    await store.abandon('s', 'k1');
    expect(await store.begin('s', 'k1', HASH_A, at(3600), at(3602))).toEqual({ state: 'started' });
    const racers = await Promise.all(Array.from({ length: 10 }, () => store.begin('s', 'k2', HASH_A, at(3600), at(0))));
    expect(racers.filter((r) => r.state === 'started')).toHaveLength(1);
    expect(await store.purgeExpired(at(10_000))).toBe(2);
  });

  it('veritabanı kısıtları biçimi ve yanıt durumunu korur', async () => {
    await expect(
      db.client.$executeRaw`INSERT INTO idempotency_records (scope, key, request_hash, state, expires_at)
        VALUES ('s', 'k', 'DÜZ-METİN', 'in_progress', now())`,
    ).rejects.toThrow(/request_hash_hex32/);
    await expect(
      db.client.$executeRaw`INSERT INTO idempotency_records (scope, key, request_hash, state, expires_at)
        VALUES ('s', 'k', ${HASH_A}, 'completed', now())`,
    ).rejects.toThrow(/state_response/);
  });

  it('idempotent istek uçtan uca: ikinci istek kaydedilen yanıtı alır', async () => {
    const idem = createIdempotency({ store: createPrismaIdempotencyStore(db.client), ttlSeconds: 3600 });
    let calls = 0;
    const handler = async () => ({ status: 201, body: { calls: (calls += 1) } });
    const request = { method: 'POST', path: '/v1/tx', body: { call: 'buyClaim' } };
    const key = randomUUID();
    expect(await idem.run({ scope: 'api:A', key, request, handler })).toEqual({
      status: 201,
      body: { calls: 1 },
      replayed: false,
    });
    expect(await idem.run({ scope: 'api:A', key, request, handler })).toEqual({
      status: 201,
      body: { calls: 1 },
      replayed: true,
    });
  });
});
