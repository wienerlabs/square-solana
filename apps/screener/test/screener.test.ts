// Tarama, zincire yazma, denetim kaydı ve TTL yenileme: gerçek Postgres (global-setup), fixture RPC'deki
// registry kuralları, sentetik OFAC listesi ve sahte sağlayıcı.
import { randomBytes } from 'node:crypto';
import { createDatabaseClient, type PrismaClient } from '@squaresdk/solana-db';
import { SQUARE_IDLS, type SquareProgramName } from '@squaresdk/solana-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { evidenceHash, type Evidence } from '../src/evidence.js';
import { loadProgramIds } from '../src/programs.js';
import { assertRenewalWindow } from '../src/renewal.js';
import { ScreeningFailedError } from '../src/screener.js';
import { FixtureRegistry, PROGRAM_IDS, startRpc, type RpcServer } from './fixtures/rpc.js';
import { LISTED, LISTED_PERSON, MARGIN, RETRY, TTL, createStack, testClock } from './fixtures/stack.js';

let db: PrismaClient;
let registry: FixtureRegistry;
let rpc: RpcServer;

beforeAll(async () => {
  db = createDatabaseClient({ connectionString: inject('databaseUrl') });
  registry = new FixtureRegistry();
  rpc = await startRpc(registry);
});

afterAll(async () => {
  await rpc.close();
  await db.$disconnect();
});

beforeEach(async () => {
  registry.reset();
  await db.$executeRawUnsafe('TRUNCATE screening_decisions, screenings, rate_limit_windows');
});

const wallet = () => Keypair.generate().publicKey.toBase58();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function stack(options: { authority?: Keypair } = {}) {
  const clock = testClock(registry);
  const parts = await createStack({ db, rpcUrl: rpc.url, registry, clock, ...options });
  /** Saati ilerletir; OFAC listesi üretimdeki yenileme döngüsü gibi yeniden indirilir. */
  const advance = async (seconds: number) => {
    clock.now += seconds * 1000;
    await parts.ofac.refresh();
  };
  return { ...parts, clock, advance };
}

describe('tarama', () => {
  it('OFAC listesindeki adres: Flagged kaydı sözleşmeye göre zincire yazılır, karar denetim kaydında', async () => {
    const s = await stack();
    const row = await s.screener.screen(LISTED, { trigger: 'request', caller: 'abcdef0123456789' });
    expect(row).toMatchObject({
      wallet: LISTED,
      trigger: 'request',
      outcome: 'recorded',
      status: 'flagged',
      caller: 'abcdef0123456789',
      error: null,
    });
    // Tx: fixture talimatı IDL'le çözdü, imzacıyı RegistryConfig.screener_authority ile karşılaştırdı.
    expect(registry.sent).toHaveLength(1);
    const sent = registry.sent[0]!;
    expect(row.signature).toBe(sent.signature);
    expect((sent.args['wallet'] as PublicKey).toBase58()).toBe(LISTED);
    expect(sent.args['status']).toEqual({ flagged: {} });
    expect(sent.accounts[1]).toBe(s.authority.publicKey.toBase58());

    // Zincirdeki kayıt ve denetim satırı aynı: hash kanıttan yeniden hesaplanır.
    const onChain = registry.record(new PublicKey(LISTED))!;
    expect(hex(Uint8Array.from(onChain['sourceHash'] as number[]))).toBe(row.sourceHash);
    expect(hex(evidenceHash(row.evidence as unknown as Evidence))).toBe(row.sourceHash);
    expect(Number(row.screenedAt)).toBe(registry.now);
    expect(Number(row.expiresAt)).toBe(registry.now + TTL);
    expect(Number(row.slot)).toBe(registry.slot);
    const ofac = (row.sources as { source: string; flagged: boolean; matches?: { uid: string }[] }[]).find(
      (source) => source.source === 'ofac_sdn',
    )!;
    expect(ofac.flagged).toBe(true);
    expect(ofac.matches?.map((match) => match.uid)).toEqual(['900001', '900003']);
    expect(s.provider.requests.at(-1)).toEqual({
      url: `https://chainalysis.example.test/api/v1/address/${LISTED}`,
      apiKey: 'test-provider-key',
    });
    expect(s.logs.some((record) => JSON.stringify(record).includes('test-provider-key'))).toBe(false);
  });

  it('temiz adres Clear; sağlayıcı işaretlerse Flagged (herhangi bir kaynak yeter)', async () => {
    const s = await stack();
    const clean = wallet();
    expect((await s.screener.screen(clean, { trigger: 'request', caller: null })).status).toBe('clear');
    expect(registry.sent.at(-1)!.args['status']).toEqual({ clear: {} });

    s.provider.responses.push({
      status: 200,
      body: JSON.stringify({ identifications: [{ category: 'sanctions', name: 'SANCTIONS: OFAC SDN Test' }] }),
    });
    const byProvider = wallet();
    const row = await s.screener.screen(byProvider, { trigger: 'request', caller: null });
    expect(row.status).toBe('flagged');
    const sources = row.sources as { source: string; flagged: boolean }[];
    expect(sources.map((source) => [source.source, source.flagged])).toEqual([
      ['ofac_sdn', false],
      ['chainalysis', true],
    ]);
    expect((await s.screener.screen(LISTED_PERSON, { trigger: 'request', caller: null })).status).toBe('flagged');
  });

  it('kaynak yanıt vermezse karar verilmez, tx gönderilmez; kayıt sourceError', async () => {
    const s = await stack();
    s.provider.responses.push({ status: 500, body: 'iç hata' });
    const target = wallet();
    const error = (await s.screener
      .screen(target, { trigger: 'request', caller: null })
      .catch((e: unknown) => e)) as ScreeningFailedError;
    expect(error).toBeInstanceOf(ScreeningFailedError);
    expect(error.kind).toBe('source');
    expect(error.decision).toMatchObject({ outcome: 'sourceError', status: null, sourceHash: null, signature: null });
    expect(error.message).toMatch(/chainalysis: Chainalysis API HTTP 500/);
    expect(registry.sent).toHaveLength(0);
    expect(s.errors.count()).toBe(1);

    // Bayat liste: yenilenemeyen liste süresi dolunca OFAC de karar vermez.
    s.clock.now += 7_201_000;
    await expect(s.screener.screen(target, { trigger: 'request', caller: null })).rejects.toThrow(/SDN listesi bayat/);
    expect(await db.screeningDecision.count({ where: { wallet: target, outcome: 'sourceError' } })).toBe(2);
  });

  it('tx reddedilirse karar txFailed ve program hatasıyla kaydedilir', async () => {
    const s = await stack();
    // Authority zincirde döndürüldü: servisin anahtarı artık screener authority değil.
    await registry.setConfig({ authority: Keypair.generate().publicKey, ttl: TTL });
    const error = (await s.screener
      .screen(LISTED, { trigger: 'request', caller: null })
      .catch((e: unknown) => e)) as ScreeningFailedError;
    expect(error.kind).toBe('tx');
    expect(error.programError).toEqual({ program: 'registry', code: 6002, name: 'Unauthorized' });
    expect(error.decision).toMatchObject({ outcome: 'txFailed', status: 'flagged', signature: null, expiresAt: null });
    expect(error.decision.sourceHash).toMatch(/^[0-9a-f]{64}$/);

    // Zincirde düşen tx'in imzası kayıtta kalır.
    await registry.setConfig({ authority: s.authority.publicKey, ttl: TTL });
    registry.modes.push('fail');
    const failed = (await s.screener
      .screen(wallet(), { trigger: 'request', caller: null })
      .catch((e: unknown) => e)) as ScreeningFailedError;
    expect(failed.decision.signature).toBe(registry.sent.at(-1)!.signature);
  });

  it('aynı cüzdanın eşzamanlı taramaları tek tx paylaşır', async () => {
    const s = await stack();
    const target = wallet();
    const [a, b] = await Promise.all([
      s.screener.screen(target, { trigger: 'request', caller: null }),
      s.screener.screen(target, { trigger: 'renewal', caller: null }),
    ]);
    expect(a.id).toBe(b.id);
    expect(registry.sent).toHaveLength(1);
    // Sonraki tarama yenidir.
    await s.screener.screen(target, { trigger: 'request', caller: null });
    expect(await db.screeningDecision.count({ where: { wallet: target } })).toBe(2);
  });

  it('denetim kaydı yazılamazsa hata loglanır ve yukarı gider', async () => {
    const clock = testClock(registry);
    const s = await createStack({
      db,
      rpcUrl: rpc.url,
      registry,
      clock,
      storeOverride: (store) => ({
        ...store,
        insert: () =>
          Promise.reject(Object.assign(new Error('bağlantı yok'), { name: 'PrismaClientKnownRequestError' })),
      }),
    });
    await expect(s.screener.screen(wallet(), { trigger: 'request', caller: null })).rejects.toThrow(/bağlantı yok/);
    expect(s.logs.find((record) => record.msg === 'audit_write_failed')).toBeDefined();
  });

  it('geçersiz adres ve kaynaksız kurulum', async () => {
    const s = await stack();
    await expect(s.screener.screen('1111', { trigger: 'request', caller: null })).rejects.toThrow();
    const { createScreener } = await import('../src/screener.js');
    expect(() =>
      createScreener({
        sources: [],
        chain: s.chain,
        store: s.store,
        metrics: s.metrics,
        log: {} as never,
        errors: s.errors,
      }),
    ).toThrow(/en az bir/);
  });
});

describe('TTL yenileme', () => {
  it('expires_at yaklaşınca yeniden tarar ve yazar; yeni kayıt yeniden aday olmaz', async () => {
    const s = await stack();
    const first = await s.screener.screen(LISTED, { trigger: 'request', caller: null });
    expect(await s.renewal.runOnce()).toEqual({ candidates: 0, renewed: 0, failed: 0 });

    // Payın dışında: henüz aday değil.
    await s.advance(TTL - MARGIN - 60);
    expect((await s.renewal.runOnce()).candidates).toBe(0);
    // Payın içinde: yenilenir; zincirdeki kayıt yeni saatle yazılır.
    await s.advance(120);
    expect(await s.renewal.runOnce()).toEqual({ candidates: 1, renewed: 1, failed: 0 });
    const renewed = await s.store.latestRecorded(LISTED);
    expect(renewed).toMatchObject({ trigger: 'renewal', outcome: 'recorded', status: 'flagged', caller: null });
    expect(Number(renewed!.expiresAt)).toBe(Number(first.expiresAt) + TTL - MARGIN + 60);
    expect(Number((registry.record(new PublicKey(LISTED))!['expiresAt'] as { toString(): string }).toString())).toBe(
      Number(renewed!.expiresAt),
    );
    expect(registry.sent).toHaveLength(2);
    // Geri çekilme süresi geçse de yeni kayıt payın dışında.
    s.clock.now += (RETRY + 1) * 1000;
    expect((await s.renewal.runOnce()).candidates).toBe(0);
    expect(s.renewal.lastSuccessAt()).toBe(s.clock.now);
  });

  it('süresi geçmiş kayıt ve indexer aynasındaki kayıt da yenilenir', async () => {
    const s = await stack();
    const mirrored = wallet();
    const now = Math.floor(s.clock.now / 1000);
    await db.screening.create({
      data: {
        address: Keypair.generate().publicKey.toBase58(),
        wallet: mirrored,
        status: 'clear',
        screenedAt: BigInt(now - TTL - 10),
        expiresAt: BigInt(now - 10),
        sourceHash: randomBytes(32).toString('hex'),
        account: {},
        slot: 1n,
        indexedAt: new Date(),
      },
    });
    // Aynada eski, denetim kaydında yeni: en geç `expires_at` geçerli.
    const both = wallet();
    await db.screening.create({
      data: {
        address: Keypair.generate().publicKey.toBase58(),
        wallet: both,
        status: 'clear',
        screenedAt: BigInt(now - TTL),
        expiresAt: BigInt(now),
        sourceHash: randomBytes(32).toString('hex'),
        account: {},
        slot: 1n,
        indexedAt: new Date(),
      },
    });
    s.clock.now -= (RETRY + 1) * 1000;
    await s.screener.screen(both, { trigger: 'request', caller: null });
    s.clock.now += (RETRY + 1) * 1000;
    expect(await s.renewal.runOnce()).toEqual({ candidates: 1, renewed: 1, failed: 0 });
    expect((await s.store.latestRecorded(mirrored))?.trigger).toBe('renewal');
  });

  it('başarısız yenileme geri çekilir ve süre sonunda yeniden denenir', async () => {
    const s = await stack();
    await s.screener.screen(LISTED, { trigger: 'request', caller: null });
    await s.advance(TTL - MARGIN + 1);
    s.provider.always = 'throw';
    expect(await s.renewal.runOnce()).toEqual({ candidates: 1, renewed: 0, failed: 1 });
    expect((await s.renewal.runOnce()).candidates).toBe(0);
    s.clock.now += (RETRY + 1) * 1000;
    s.provider.always = null;
    expect(await s.renewal.runOnce()).toEqual({ candidates: 1, renewed: 1, failed: 0 });
    const history = await s.store.history(LISTED, { page: 1, limit: 10 });
    expect(history.items.map((row) => row.outcome)).toEqual(['recorded', 'sourceError', 'recorded']);
  });

  it('beklenmeyen hata koşuyu durdurur; pay TTL’den küçük olmalı', async () => {
    const clock = testClock(registry);
    const s = await createStack({
      db,
      rpcUrl: rpc.url,
      registry,
      clock,
      storeOverride: (store) => ({
        ...store,
        renewalCandidates: async () => [{ wallet: wallet(), expiresAt: 0 }],
        insert: () => Promise.reject(new Error('disk dolu')),
      }),
    });
    await expect(s.renewal.runOnce()).rejects.toThrow(/disk dolu/);
    expect(s.renewal.lastSuccessAt()).toBeNull();
    expect(() => assertRenewalWindow(TTL, TTL)).toThrow(/küçük olmalı/);
    expect(() => assertRenewalWindow(MARGIN, TTL)).not.toThrow();
  });
});

describe('program kimlikleri', () => {
  it('programs tablosundan; eksik ya da farklı IDL sürümü açılışı durdurur', async () => {
    await db.program.deleteMany();
    await expect(loadProgramIds(db)).rejects.toThrow(/registry: programs tablosunda yok/);
    await db.program.createMany({
      data: (Object.keys(PROGRAM_IDS) as SquareProgramName[]).map((name) => ({
        name,
        programId: PROGRAM_IDS[name].toBase58(),
        idlVersion: name === 'escrow' ? '0.0.1' : SQUARE_IDLS[name].metadata.version,
      })),
    });
    await expect(loadProgramIds(db)).rejects.toThrow(/escrow: IDL sürümü 0.0.1/);
    await db.program.update({ where: { name: 'escrow' }, data: { idlVersion: SQUARE_IDLS.escrow.metadata.version } });
    expect((await loadProgramIds(db)).registry.equals(PROGRAM_IDS.registry)).toBe(true);
    await db.program.deleteMany();
  });
});
