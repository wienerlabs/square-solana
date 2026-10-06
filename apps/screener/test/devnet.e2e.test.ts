// Uçtan uca devnet koşusu (BE-16 kabul kriterleri): gerçek OFAC SDN listesi, devnet'teki square_registry ve
// screener authority anahtarı. Yalnızca `SCREENER_E2E_*` ortamıyla çalışır (anahtar repoda tutulmaz):
//   SCREENER_E2E_AUTHORITY  screener authority keypair'i (`RegistryConfig.screener_authority`, SOL'ü var)
//   SCREENER_E2E_REPORT     isteğe bağlı: koşunun imzalarının yazılacağı JSON dosyası
// Ağ ve programlar `scripts/deploy/networks/devnet.json` ve `Anchor.toml`'dandır; veritabanı testlerin Postgres
// konteyneridir (global-setup). Senaryo:
//   1. Listedeki bir SOL adresi taranır: zincire `Flagged` kayıt yazılır, `source_hash` denetim kaydındakidir.
//   2. Listede olmayan yeni bir cüzdan `Clear` yazılır.
//   3. Yenilemenin saati süre dolumuna `margin` kalana ilerletilir: iki cüzdan yeniden taranır ve zincirdeki
//      `expires_at` ileri gider.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient, type PrismaClient } from '@squaresdk/solana-db';
import { createEventWindow, createLogger } from '@squaresdk/solana-observability';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { OFAC_SDN_URL } from '../../../scripts/deploy/sanctions.mjs';
import { createChain, type ScreeningChain } from '../src/chain.js';
import { createMetrics } from '../src/metrics.js';
import { createRenewal } from '../src/renewal.js';
import { createScreener, type Screener } from '../src/screener.js';
import { createOfacSource, type OfacSource } from '../src/sources/ofac.js';
import { createDecisionStore, type DecisionStore } from '../src/store.js';

const ENV = {
  authority: process.env['SCREENER_E2E_AUTHORITY'],
  report: process.env['SCREENER_E2E_REPORT'],
};

const SECOND = 1_000;
/** Gerçek liste ~30 MB; sınır üstünde pay. */
const SDN_MAX_BYTES = 64 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const OFAC_TIMEOUT_MS = 120_000;
const COMPUTE_UNIT_PRICE = 1_000n;
const CONFIRM_POLL_MS = 1_000;
/** Yenilemenin kaydı süresinden ne kadar önce yeniden taradığı (sn). */
const MARGIN_SECONDS = 3_600;

interface Network {
  rpc: string;
  programs: Record<string, string>;
}

describe.skipIf(!ENV.authority)('devnet: OFAC listesiyle tarama ve TTL yenileme', () => {
  let db: PrismaClient;
  let store: DecisionStore;
  let chain: ScreeningChain;
  let ofac: OfacSource;
  let screener: Screener;
  let ttl: number;
  const signatures: Record<string, string> = {};
  const metrics = createMetrics({ service: 'screener-e2e', version: '0.0.0' });
  const log = createLogger({ service: 'screener-e2e', level: 'warn' });
  const errors = createEventWindow({ windowSeconds: 60 });

  beforeAll(async () => {
    db = createDatabaseClient({ connectionString: inject('databaseUrl') });
    await db.$executeRawUnsafe('TRUNCATE screening_decisions, screenings');
    store = createDecisionStore(db);
    const network = loadNetwork(fileURLToPath(new URL('../../../', import.meta.url)), 'devnet') as Network;
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(ENV.authority!, 'utf8'))));
    chain = createChain({
      urls: [network.rpc],
      timeoutMs: RPC_TIMEOUT_MS,
      cooldownMs: RPC_TIMEOUT_MS,
      programIds: Object.fromEntries(
        Object.entries(network.programs).map(([name, id]) => [name, new PublicKey(id)]),
      ) as Parameters<typeof createChain>[0]['programIds'],
      authority,
      computeUnitPrice: COMPUTE_UNIT_PRICE,
      confirmPollMs: CONFIRM_POLL_MS,
    });
    const config = await chain.registryConfig();
    expect(config?.screenerAuthority.toBase58()).toBe(authority.publicKey.toBase58());
    ttl = config!.screeningTtlSecs;
    ofac = createOfacSource({
      url: OFAC_SDN_URL,
      timeoutMs: OFAC_TIMEOUT_MS,
      maxBytes: SDN_MAX_BYTES,
      maxAgeSeconds: ttl,
    });
    await ofac.refresh();
    screener = createScreener({ sources: [ofac], chain, store, metrics, log, errors });
  }, 300_000);

  afterAll(async () => {
    if (ENV.report)
      writeFileSync(ENV.report, `${JSON.stringify({ list: ofac?.list()?.sha256, signatures }, null, 2)}\n`);
    await db?.$disconnect();
  });

  const listed = () => [...ofac.list()!.addresses.keys()].sort()[0]!;
  const clean = Keypair.generate().publicKey.toBase58();

  it('listedeki adres Flagged, listede olmayan Clear olarak zincire yazılır', async () => {
    expect(ofac.list()!.addresses.size).toBeGreaterThan(0);
    for (const [wallet, status] of [
      [listed(), 'flagged'],
      [clean, 'clear'],
    ] as const) {
      const decision = await screener.screen(wallet, { trigger: 'request', caller: null });
      expect(decision).toMatchObject({ outcome: 'recorded', status });
      signatures[`${status}:${wallet}`] = decision.signature!;
      const record = await chain.screeningRecord(new PublicKey(wallet), Number(decision.slot));
      expect(record?.status).toBe(status);
      expect(Buffer.from(record!.sourceHash).toString('hex')).toBe(decision.sourceHash);
      expect(record!.expiresAt - record!.screenedAt).toBe(ttl);
    }
  }, 180_000);

  it('süresi dolmak üzere olan kayıtlar yenilenir', async () => {
    const before = new Map<string, number>();
    for (const wallet of [listed(), clean])
      before.set(wallet, (await chain.screeningRecord(new PublicKey(wallet)))!.expiresAt);
    const shift = (ttl - MARGIN_SECONDS + 60) * SECOND;
    const renewal = createRenewal({
      store,
      screener,
      marginSeconds: MARGIN_SECONDS,
      retrySeconds: 60,
      batch: 10,
      metrics,
      log,
      clock: () => Date.now() + shift,
    });
    expect(await renewal.runOnce()).toEqual({ candidates: 2, renewed: 2, failed: 0 });
    for (const [wallet, previous] of before) {
      const latest = await store.latestRecorded(wallet);
      expect(latest?.trigger).toBe('renewal');
      signatures[`renewal:${wallet}`] = latest!.signature!;
      const record = await chain.screeningRecord(new PublicKey(wallet), Number(latest!.slot));
      expect(record!.expiresAt).toBeGreaterThan(previous);
    }
  }, 180_000);
});
