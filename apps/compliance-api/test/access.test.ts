// Kayıt uçlarının erişimi (BE-32): anahtarsız, yanlış anahtarlı istek 401; doğru anahtar geçer; sınır anahtar
// başınadır ve Postgres'teki ortak sayaçla (`rate_limit_windows`) uygulanır. Uçlar servisin kendi router'ları değil,
// erişim ara katmanının arkasındaki bir yankı uçudur: router'ların kendisi bu testin konusu değil.
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createRateLimiter } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyCheck, requireApiKey } from '../src/middleware/access.js';

const LIMIT = 3;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const KEYS = [randomBytes(24).toString('base64url'), randomBytes(24).toString('base64url')];

let db: IsolatedDatabase;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await startIsolatedDatabase();
  const app = express();
  app.use(
    '/api/v1/proofs',
    requireApiKey({
      check: apiKeyCheck(KEYS.map(sha256)),
      limiter: Promise.resolve(
        createRateLimiter({ store: createPrismaRateLimitStore(db.client), rule: { limit: LIMIT, windowSeconds: 60 } }),
      ),
    }),
    (_req, res) => {
      res.json({ success: true, data: 'kayıt', error: null });
    },
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/proofs`;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await db?.stop();
});

const call = (key?: string) => fetch(base, { method: 'POST', headers: key ? { 'x-api-key': key } : {} });

describe('kayıt uçlarının erişimi', () => {
  it('anahtarsız ve yanlış anahtarlı istek 401; özet listesindeki anahtar geçer', async () => {
    const missing = await call();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ success: false, data: null, error: 'geçerli bir X-API-Key gerekli' });
    expect((await call(randomBytes(24).toString('base64url'))).status).toBe(401);
    expect((await call(sha256(KEYS[0]!))).status).toBe(401);
    const allowed = await call(KEYS[0]);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('ratelimit-limit')).toBe(String(LIMIT));
  });

  it('sınır anahtar başına: dolan anahtar 429 alır, diğeri etkilenmez', async () => {
    for (let i = 0; i < LIMIT; i += 1) expect((await call(KEYS[1])).status).toBe(200);
    const limited = await call(KEYS[1]);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ success: false, data: null, error: 'hız sınırı aşıldı' });
    expect((await call(KEYS[0])).status).toBe(200);
    const rows = await db.client.rateLimitWindow.findMany();
    expect(rows.every((row) => row.key.startsWith('compliance:key:') && !row.key.includes(KEYS[1]!))).toBe(true);
  });
});
