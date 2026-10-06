// HTTP yüzeyi: yetki, hız sınırı, tarama, son karar, denetim geçmişi, hata zarfları, health ve OpenAPI.
// Uygulama yerel bir portta açılır; parçalar üretimdeki gibi kurulur (fixtures/stack.ts).
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabaseClient, type PrismaClient } from '@squaresdk/solana-db';
import { createLogger, createServiceMetrics } from '@squaresdk/solana-observability';
import { Keypair } from '@solana/web3.js';
import type express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, inject } from 'vitest';
import { createMetricsApp } from '../src/app.js';
import { ScreeningDecisionSchema, screenerEnvelope } from '../src/schemas.js';
import { FixtureRegistry, startRpc, type RpcServer } from './fixtures/rpc.js';
import { API_KEY, LISTED, createStack, testClock } from './fixtures/stack.js';
import type { DecisionStore } from '../src/store.js';

let db: PrismaClient;
let registry: FixtureRegistry;
let rpc: RpcServer;
const servers: Server[] = [];

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject('databaseUrl') });
  registry = new FixtureRegistry();
  rpc = await startRpc(registry);
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rpc.close();
  await db.$disconnect();
});

beforeEach(async () => {
  registry.reset();
  await db.$executeRawUnsafe('TRUNCATE screening_decisions, screenings, rate_limit_windows');
});

/** Yanıt gövdesi: zarf ya da zarfsız (health, OpenAPI). */
interface Body {
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly programError: unknown;
    readonly details: { reason?: string; decisionId?: string; issues?: { path: string }[] };
  };
  readonly meta?: { requestId: string; page: number | null; limit: number | null; total: number | null };
  readonly openapi?: string;
  readonly paths?: Record<string, unknown>;
}

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function start(options: Partial<Parameters<typeof createStack>[0]> = {}) {
  const clock = testClock(registry);
  const s = await createStack({ db, rpcUrl: rpc.url, registry, clock, ...options });
  const base = await serve(s.app);
  const call = async (method: string, path: string, init: { body?: string; key?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (init.key !== null) headers['x-api-key'] = init.key ?? API_KEY;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${path}`, { method, headers, body: init.body });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Body) : null,
    };
  };
  return { ...s, clock, base, call };
}

const Decision = screenerEnvelope(ScreeningDecisionSchema);
const wallet = () => Keypair.generate().publicKey.toBase58();

describe('yetki ve hız sınırı', () => {
  it('anahtarsız ya da yanlış anahtarlı istek 401; health, ready ve openapi açık', async () => {
    const s = await start();
    expect((await s.call('POST', '/v1/screenings', { key: null, body: '{}' })).status).toBe(401);
    const wrong = await s.call('GET', `/v1/screenings/${LISTED}`, { key: 'yanlis' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ success: false, error: { code: 'unauthorized' } });
    expect(wrong.body!.meta!.requestId).toBe(wrong.headers.get('x-request-id'));
    expect((await s.call('GET', '/health', { key: null })).body).toMatchObject({ status: 'ok' });
    expect((await s.call('GET', '/ready', { key: null })).body).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', ofac: 'ok' },
    });
    const openapi = await s.call('GET', '/openapi.json', { key: null });
    expect(openapi.body!.openapi).toBe('3.1.0');
    expect(Object.keys(openapi.body!.paths!)).toEqual([
      '/v1/screenings',
      '/v1/screenings/{wallet}',
      '/v1/screenings/{wallet}/history',
      '/health',
      '/ready',
    ]);
    expect((await s.call('GET', '/yok')).body).toMatchObject({ error: { code: 'not_found' } });
  });

  it('tarama ve okuma anahtar başına ayrı sınırlıdır', async () => {
    const s = await start({ rateLimit: { screen: 1, read: 2 } });
    expect((await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: wallet() }) })).status).toBe(200);
    const limited = await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: wallet() }) });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: 'rate_limited' } });
    expect(limited.headers.get('retry-after')).not.toBeNull();
    expect(registry.sent).toHaveLength(1);
    expect((await s.call('GET', `/v1/screenings/${wallet()}`)).status).toBe(404);
    expect((await s.call('GET', `/v1/screenings/${wallet()}`)).status).toBe(404);
    expect((await s.call('GET', `/v1/screenings/${wallet()}`)).status).toBe(429);
  });
});

describe('tarama uçları', () => {
  it('POST tarar ve zincire yazar; GET son kararı ve denetim geçmişini döner', async () => {
    const s = await start();
    const screened = await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: LISTED }) });
    expect(screened.status).toBe(200);
    const view = Decision.parse(screened.body);
    expect(view.data).toMatchObject({
      wallet: LISTED,
      trigger: 'request',
      outcome: 'recorded',
      status: 'flagged',
      signature: registry.sent[0]!.signature,
      screenedAt: registry.now,
      expiresAt: registry.now + 86_400,
    });
    const caller = await db.screeningDecision.findFirstOrThrow();
    expect(caller.caller).toMatch(/^[0-9a-f]{16}$/);

    // Sonraki tarama sağlayıcı yanıt vermediği için başarısız: son karar değişmez, geçmişte görünür.
    s.clock.now += 1_000;
    s.provider.responses.push('throw');
    const failed = await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: LISTED }) });
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ error: { code: 'source_unavailable' } });
    expect(failed.body!.error!.details.reason).toMatch(/Chainalysis API yanıt vermedi/);

    const latest = await s.call('GET', `/v1/screenings/${LISTED}`);
    expect(Decision.parse(latest.body).data?.id).toBe(view.data!.id);
    const history = await s.call('GET', `/v1/screenings/${LISTED}/history?limit=1&page=2`);
    expect(history.body!.meta).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect((history.body!.data as { id: string }[]).map((row) => row.id)).toEqual([view.data!.id]);
    expect((await s.call('GET', `/v1/screenings/${LISTED}/history?limit=500`)).status).toBe(400);
    expect((await s.call('GET', `/v1/screenings/${LISTED}/history?x=1`)).status).toBe(400);
    expect(failed.body!.error!.details.decisionId).toBe(
      ((await s.call('GET', `/v1/screenings/${LISTED}/history`)).body!.data as { id: string }[])[0]!.id,
    );
  });

  it('tx yazılamazsa 502 tx_failed ve program hatası', async () => {
    const s = await start();
    await registry.setConfig({ authority: Keypair.generate().publicKey, ttl: 86_400 });
    const response = await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: wallet() }) });
    expect(response.status).toBe(502);
    expect(response.body!.error).toMatchObject({
      code: 'tx_failed',
      programError: { program: 'registry', code: 6002, name: 'Unauthorized' },
    });
  });

  it('geçersiz gövde, adres ve JSON 400; büyük gövde 413', async () => {
    const s = await start();
    const invalid = await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: 'xyz' }) });
    expect(invalid.status).toBe(400);
    expect(invalid.body!.error!.details.issues?.[0]?.path).toBe('wallet');
    expect((await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: LISTED, x: 1 }) })).status).toBe(
      400,
    );
    expect((await s.call('POST', '/v1/screenings', { body: '{bozuk' })).status).toBe(400);
    expect(
      (await s.call('POST', '/v1/screenings', { body: JSON.stringify({ wallet: 'x'.repeat(2_000) }) })).status,
    ).toBe(413);
    expect((await s.call('GET', '/v1/screenings/0OIl')).status).toBe(400);
  });

  it('veritabanı hatası 503 db_unavailable, beklenmeyen hata 500', async () => {
    const failing = (error: Error) => (store: DecisionStore) => ({
      ...store,
      latestRecorded: () => Promise.reject(error),
    });
    const down = await start({
      storeOverride: failing(Object.assign(new Error('bağlantı yok'), { code: 'P1001' })),
    });
    expect((await down.call('GET', `/v1/screenings/${LISTED}`)).body).toMatchObject({
      error: { code: 'db_unavailable' },
    });
    const broken = await start({ storeOverride: failing(new Error('beklenmeyen')) });
    const response = await broken.call('GET', `/v1/screenings/${LISTED}`);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: 'internal_error' } });
  });
});

describe('metrik uygulaması', () => {
  it('GET /metrics ve 404', async () => {
    const metrics = createServiceMetrics({ service: 'screener-test', version: '0.0.0' });
    const base = await serve(createMetricsApp(metrics.registry, createLogger({ service: 't', level: 'error' })));
    const response = await fetch(`${base}/metrics`);
    expect(await response.text()).toContain('square_build_info');
    expect((await fetch(`${base}/x`)).status).toBe(404);
    const failing = { metrics: () => Promise.reject(new Error('x')), contentType: 'text/plain' };
    const broken = await serve(
      createMetricsApp(failing as never, createLogger({ service: 't', level: 'error', sink: { out() {}, err() {} } })),
    );
    expect((await fetch(`${broken}/metrics`)).status).toBe(500);
  });
});
