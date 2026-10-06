// Test fixture: screener'ın parçalarını üretimdeki gibi kurar (index.ts'in bağlaması). Veritabanı paylaşılan
// Postgres konteyneridir (global-setup), zincir fixture RPC'dir, OFAC listesi commit'lenmiş sentetik
// fikstürdür (sahte fetch), Chainalysis sahte fetch'tir. Saat testin elindedir; fixture programın saati
// (`FixtureRegistry.now`) aynı saate bağlanır.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@squaresdk/solana-db';
import { createRateLimiter } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import { createEventWindow, createHealth, createLogger, type LogRecord } from '@squaresdk/solana-observability';
import { Keypair } from '@solana/web3.js';
import { createApp } from '../../src/app.js';
import { apiKeyCheck } from '../../src/auth.js';
import { createChain } from '../../src/chain.js';
import { createMetrics } from '../../src/metrics.js';
import { createRenewal } from '../../src/renewal.js';
import { createScreener } from '../../src/screener.js';
import { createChainalysisSource } from '../../src/sources/chainalysis.js';
import { createOfacSource } from '../../src/sources/ofac.js';
import { createDecisionStore, type DecisionStore } from '../../src/store.js';
import { PROGRAM_IDS, type FixtureRegistry } from './rpc.js';

export const SDN_XML = readFileSync(new URL('./sdn.xml', import.meta.url), 'utf8');
/** Fikstürde iki SDN kaydıyla listelenen adres (uid 900001 ve 900003). */
export const LISTED = 'FR5pWwinRBn35GNhg7bsvw8Q13kRept2pm561DwZCQzT';
/** Fikstürde bir SDN kaydıyla listelenen adres (uid 900002). */
export const LISTED_PERSON = '4Yk9HoDSfJv9QcmJbLcXdWVgS7nfvdUqiVcvbSu8VBru';
export const TTL = 86_400;
export const MARGIN = 3_600;
export const RETRY = 600;
/** Testte kullanılan API anahtarı (çalışma anında üretilir) ve SHA-256'sı ortamdaki gibi. */
export const API_KEY = `sk-screener-${Keypair.generate().publicKey.toBase58()}`;

export interface ChainalysisFake {
  /** Sonraki yanıtlar; boşsa temiz yanıt. `throw` ağ hatasıdır. */
  readonly responses: ({ status: number; body: string } | 'throw')[];
  /** Hep bu yanıt (kuyruk boşken); null temiz yanıt. */
  always: { status: number; body: string } | 'throw' | null;
  readonly requests: { url: string; apiKey: string | null }[];
}

export function chainalysisFake(): ChainalysisFake & { fetch: typeof fetch } {
  const fake: ChainalysisFake = { responses: [], always: null, requests: [] };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fake.requests.push({ url: String(input), apiKey: headers.get('x-api-key') });
    const next = fake.responses.shift() ?? fake.always ?? { status: 200, body: '{"identifications":[]}' };
    if (next === 'throw') throw new TypeError('fetch failed');
    return new Response(next.body, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return Object.assign(fake, { fetch: fetchImpl });
}

export function sdnFetch(body: () => string | null = () => SDN_XML): typeof fetch {
  return (async () => {
    const xml = body();
    return xml === null ? new Response('hata', { status: 503 }) : new Response(xml, { status: 200 });
  }) as typeof fetch;
}

export interface Clock {
  now: number;
  (): number;
}

/** Testin saati (ms); `registry.now` her okumada eşitlenir. */
export function testClock(registry: FixtureRegistry, start = 1_790_000_000_000): Clock {
  const clock = (() => {
    registry.now = Math.floor(clock.now / 1000);
    return clock.now;
  }) as Clock;
  clock.now = start;
  registry.now = Math.floor(start / 1000);
  return clock;
}

export async function createStack(params: {
  db: PrismaClient;
  rpcUrl: string;
  registry: FixtureRegistry;
  authority?: Keypair;
  clock: Clock;
  storeOverride?: (store: DecisionStore) => DecisionStore;
  rateLimit?: { screen: number; read: number };
}) {
  const { db, registry, clock } = params;
  const authority = params.authority ?? Keypair.generate();
  await registry.setConfig({ authority: authority.publicKey, ttl: TTL });
  registry.setBalance(authority.publicKey, 10_000_000_000);
  const logs: LogRecord[] = [];
  const log = createLogger({
    service: 'screener-test',
    level: 'debug',
    sink: { out: () => undefined, err: () => undefined },
    observers: [(record) => logs.push(record)],
  });
  const metrics = createMetrics({ service: 'screener-test', version: '0.0.0' });
  const errors = createEventWindow({ windowSeconds: 60, clock });
  const chain = createChain({
    urls: [params.rpcUrl],
    timeoutMs: 5_000,
    cooldownMs: 60_000,
    programIds: PROGRAM_IDS,
    authority,
    computeUnitPrice: 1_000n,
    confirmPollMs: 1,
  });
  let sdn: string | null = SDN_XML;
  const ofac = createOfacSource({
    url: 'https://sdn.example.test/SDN.XML',
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
    maxAgeSeconds: 7_200,
    fetch: sdnFetch(() => sdn),
    clock,
  });
  await ofac.refresh();
  const provider = chainalysisFake();
  const chainalysis = createChainalysisSource({
    url: 'https://chainalysis.example.test',
    apiKey: 'test-provider-key',
    timeoutMs: 5_000,
    fetch: provider.fetch,
  });
  const baseStore = createDecisionStore(db);
  const store = params.storeOverride ? params.storeOverride(baseStore) : baseStore;
  const screener = createScreener({ sources: [ofac, chainalysis], chain, store, metrics, log, errors, clock });
  const renewal = createRenewal({
    store,
    screener,
    marginSeconds: MARGIN,
    retrySeconds: RETRY,
    batch: 50,
    metrics,
    log,
    clock,
  });
  const health = createHealth({
    version: '0.0.0',
    checks: { database: async () => void (await db.$queryRaw`SELECT 1`), ofac: () => ofac.fresh() },
    timeoutMs: 2_000,
    logger: log,
  });
  const rateStore = createPrismaRateLimitStore(db);
  const window = (limit: number) => createRateLimiter({ store: rateStore, rule: { limit, windowSeconds: 60 } });
  const app = createApp({
    info: { name: '@squaresdk/solana-screener', version: '0.0.0' },
    screener,
    store,
    checkApiKey: apiKeyCheck([sha256(API_KEY)]),
    limiters: {
      screen: window(params.rateLimit?.screen ?? 1_000),
      read: window(params.rateLimit?.read ?? 1_000),
    },
    health,
    metrics,
    log,
    jsonMaxBytes: 1_024,
  });
  return {
    authority,
    chain,
    ofac,
    provider,
    store,
    screener,
    renewal,
    metrics,
    errors,
    logs,
    app,
    /** Sonraki OFAC indirmesinin gövdesi; null HTTP 503. */
    setSdn(value: string | null) {
      sdn = value;
    },
  };
}

export const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
