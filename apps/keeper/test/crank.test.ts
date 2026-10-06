// Crank uçtan uca: aday seçimi (indexer aynası), zincir okuması, kârlılık, simülasyon, gönderim ve onay,
// günlük ve geri çekilme. Veritabanı gerçek Postgres (Testcontainers), zincir yerel fixture RPC.
import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createLogger } from '@squaresdk/solana-observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCrank, type Crank } from '../src/crank.js';
import { createJournal } from '../src/journal.js';
import { createMetrics, type KeeperMetrics } from '../src/metrics.js';
import { createStateReader } from '../src/state.js';
import { FixtureRpc, rentExempt, startRpc, type RpcServer } from './fixtures/rpc.js';
import { AMOUNT, KEEPER_FEE_BPS, NOW, PROGRAM_IDS, World } from './fixtures/world.js';

let db: IsolatedDatabase;
let rpc: FixtureRpc;
let server: RpcServer;
let world: World;
let keeper: Keypair;
let now: number;
let errors: number;
let metrics: KeeperMetrics;

const FEE = (AMOUNT * BigInt(KEEPER_FEE_BPS)) / 10_000n;
const BACKOFF = { baseSeconds: 60, maxSeconds: 3_600 };

function crank(economics: { mintUnitsPerSol?: bigint; minMarginBps?: number } = {}): Crank {
  metrics = createMetrics({ service: 'keeper-test', version: '0.0.0' });
  return createCrank({
    client: world.client,
    connection: world.client.registry.program.provider.connection,
    reader: createStateReader({ client: world.client, connection: world.client.registry.program.provider.connection }),
    journal: createJournal(db.client),
    keeper,
    economics: {
      mintUnitsPerSol: economics.mintUnitsPerSol ?? 150_000_000n,
      minMarginBps: economics.minMarginBps ?? 0,
      priorityFeePercentile: 75,
      maxComputeUnitPrice: 50_000n,
    },
    backoff: BACKOFF,
    batchSize: 10,
    confirmPollMs: 5,
    metrics,
    log: createLogger({ service: 'keeper-test', level: 'error' }),
    onError: () => {
      errors += 1;
    },
    clock: () => now,
  });
}

const escrowError = (name: string) => world.programs.escrow.idl.errors!.find((error) => error.name === name)!.code;
const failing = (code: number) => {
  const escrow = PROGRAM_IDS.escrow.toBase58();
  return {
    err: { InstructionError: [2, { Custom: code }] },
    logs: [`Program ${escrow} invoke [1]`, `Program ${escrow} failed: custom program error: 0x${code.toString(16)}`],
  };
};
const actions = (job: string) =>
  db.client.keeperAction.findMany({ where: { job }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });

beforeAll(async () => {
  db = await startIsolatedDatabase();
  rpc = new FixtureRpc();
  server = await startRpc(rpc);
});
afterAll(async () => {
  await server.close();
  await db.stop();
});
beforeEach(async () => {
  await db.truncate();
  rpc.reset();
  world = new World(rpc, db.client, server.url);
  keeper = Keypair.generate();
  now = NOW * 1000;
  errors = 0;
  await world.setup();
});

describe('finalize', () => {
  it('kârlı job finalize edilir: keeper token hesabı bir kez açılır, tx gönderilir, onay ve ücret günlükte', async () => {
    const job = await world.job();
    world.tokenAccount(job.payee);
    world.tokenAccount(job.institution);
    rpc.prioritizationFees = [100, 400, 200, 300];
    const result = await crank().runOnce();
    expect(result).toEqual({ evaluated: 1, confirmed: 1 });

    // 1: keeper'ın token hesabı, 2: finalize.
    expect(rpc.sent).toHaveLength(2);
    const finalize = rpc.sent[1]!;
    const keys = finalize.message.staticAccountKeys;
    const programs = finalize.message.compiledInstructions.map((ix) => keys[ix.programIdIndex]!.toBase58());
    expect(programs).toContain(PROGRAM_IDS.escrow.toBase58());
    expect(keys[0]!.equals(keeper.publicKey)).toBe(true);
    const price = finalize.message.compiledInstructions.find(
      (ix) => keys[ix.programIdIndex]!.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3,
    )!;
    // Yüzdelik 75 → 300 mikro-lamport.
    expect(Buffer.from(price.data).readBigUInt64LE(1)).toBe(300n);
    expect(finalize.signatures[0]!.some((byte) => byte !== 0)).toBe(true);

    const journal = await actions(job.address.toBase58());
    expect(journal.map((a) => [a.outcome, a.reason, a.keeperFee?.toString() ?? null])).toEqual([
      ['submitted', null, null],
      ['confirmed', null, FEE.toString()],
    ]);
    expect(journal[1]!.signature).toBe(journal[0]!.signature);
    expect(await metrics.registry.metrics()).toContain(`keeper_fees_earned_total{service="keeper-test"} ${FEE}`);

    // Zincirde job artık ödenmiş; ayna henüz güncellenmese de yeniden gönderilmez, günlüğe yazılmaz.
    const current = await world.client.escrow.fetch('job', job.address);
    await world.put('escrow', 'job', job.address, { ...current!, status: { released: {} } });
    expect(await crank().runOnce()).toEqual({ evaluated: 1, confirmed: 0 });
    expect(rpc.sent).toHaveLength(2);
    expect(await actions(job.address.toBase58())).toHaveLength(2);
  });

  it('kârsız job günlüğe yazılır ve tx gönderilmez', async () => {
    const job = await world.job();
    world.tokenAccount(keeper.publicKey);
    // 1 SOL = 1e15 birim: maliyet ücreti aşar.
    expect(await crank({ mintUnitsPerSol: 1_000_000_000_000_000n }).runOnce()).toEqual({ evaluated: 1, confirmed: 0 });
    expect(rpc.sent).toHaveLength(0);
    const [entry] = await actions(job.address.toBase58());
    expect(entry).toMatchObject({ outcome: 'skipped', reason: 'unprofitable' });
    expect(entry!.nextAttemptAt!.getTime()).toBe(now + BACKOFF.baseSeconds * 1000);
  });

  it('maliyet: mesaj ücreti ve keeper’ın açacağı hesapların rent’i (validation, itibar, eksik token hesapları)', async () => {
    await world.job();
    world.tokenAccount(keeper.publicKey);
    const validation = rentExempt(8 + 32 + 32 + 1 + 2 + 8 + 1 + 33 + 33);
    // Eşik: ücret = maliyet × birim fiyat; maliyet = mesaj + validation + itibar + iki token hesabı.
    const cost =
      BigInt(rpc.messageFee + validation) +
      BigInt(rentExempt(8 + 32 + 8 * 4 + 8 * 2 + 1)) +
      2n * BigInt(rentExempt(165));
    const breakEven = (FEE * 1_000_000_000n) / cost;
    expect(await crank({ mintUnitsPerSol: breakEven }).runOnce()).toMatchObject({ confirmed: 1 });
    const job = await world.job();
    expect(await crank({ mintUnitsPerSol: breakEven + 1_000n }).runOnce()).toMatchObject({ confirmed: 0 });
    expect((await actions(job.address.toBase58()))[0]).toMatchObject({ reason: 'unprofitable' });
  });
});

describe('bekletme', () => {
  it('ProofRequired sürekli denenmez: geri çekilir, ispat indexlenince beklemeden denenir', async () => {
    const job = await world.job({ policy: 'missing' });
    world.tokenAccount(keeper.publicKey);
    const keeperCrank = crank();
    await keeperCrank.runOnce();
    const [first] = await actions(job.address.toBase58());
    expect(first).toMatchObject({ outcome: 'skipped', reason: 'proofRequired' });
    expect(first!.nextAttemptAt!.getTime()).toBe(now + 60_000);

    // Zamanı gelmeden aday değil.
    now += 30_000;
    expect(await keeperCrank.runOnce()).toEqual({ evaluated: 0, confirmed: 0 });
    // Zamanı geldi, ispat hâlâ yok: aralık ikiye katlanır.
    now += 31_000;
    await keeperCrank.runOnce();
    const second = (await actions(job.address.toBase58()))[1]!;
    expect(second.nextAttemptAt!.getTime()).toBe(now + 120_000);

    // İspat zincirde bağlandı ve indexlendi: geri çekilme beklenmez.
    now += 1_000;
    await world.proof(job, 'compliant');
    world.tokenAccount(job.payee);
    world.tokenAccount(job.institution);
    await db.client.releaseProof.create({
      data: {
        address: world.client.pda.releaseProof(job.address)[0].toBase58(),
        job: job.address.toBase58(),
        institution: job.institution.toBase58(),
        policy: job.policy!.toBase58(),
        payee: job.payee.toBase58(),
        verdict: 'compliant',
        refusalCode: 0,
        consumed: false,
        netAmount: (AMOUNT - FEE).toString(),
        proofTimestamp: BigInt(NOW),
        account: {},
        slot: 2n,
        indexedAt: new Date(now),
      },
    });
    expect(await keeperCrank.runOnce()).toMatchObject({ confirmed: 1 });
    expect((await actions(job.address.toBase58())).map((a) => a.outcome)).toEqual([
      'skipped',
      'skipped',
      'submitted',
      'confirmed',
    ]);
  });

  it('screening temiz değilse bekler; payee’nin kaydı indexlenince yeniden denenir', async () => {
    const job = await world.job({ screening: 'flagged' });
    world.tokenAccount(keeper.publicKey);
    const keeperCrank = crank();
    await keeperCrank.runOnce();
    expect((await actions(job.address.toBase58()))[0]).toMatchObject({ reason: 'screeningPending' });
    expect(await keeperCrank.runOnce()).toMatchObject({ evaluated: 0 });
    await db.client.screening.create({
      data: {
        address: world.key().toBase58(),
        wallet: job.payee.toBase58(),
        status: 'clear',
        screenedAt: BigInt(NOW),
        expiresAt: BigInt(NOW + 86_400),
        sourceHash: 'ab'.repeat(32),
        account: {},
        slot: 3n,
        indexedAt: new Date(now + 1),
      },
    });
    expect(await keeperCrank.runOnce()).toMatchObject({ evaluated: 1 });
  });

  it('challenge penceresi açık job aday değil', async () => {
    await world.job({ challengeEnd: NOW + 600 });
    expect(await crank().runOnce()).toEqual({ evaluated: 0, confirmed: 0 });
  });

  it('fiat iş aday değil ve birikime girmez: finalize_fiat_payment kapatır (ADR 0024)', async () => {
    await world.job({ rail: 'fiat', policy: 'compliant' });
    const keeperCrank = crank();
    expect(await keeperCrank.runOnce()).toEqual({ evaluated: 0, confirmed: 0 });
    expect(keeperCrank.oldestDueSeconds()).toBe(0);
  });
});

describe('gecikme ölçümü', () => {
  const value = async (
    metric: { get(): Promise<{ values: { metricName?: string; value: number; labels: object }[] }> },
    name: string,
    labels: Record<string, string> = {},
  ) =>
    (await metric.get()).values.find(
      (entry) =>
        (entry.metricName ?? name) === name &&
        Object.entries(labels).every(([key, label]) => (entry.labels as Record<string, unknown>)[key] === label),
    )?.value;

  it('birikim: finalize edilebilir job sayılır, bekletilen sayılmaz, beklediği kayıt indexlenince yeniden sayılır', async () => {
    const open = await world.job();
    const gated = await world.job({ policy: 'missing', challengeEnd: NOW - 300 });
    await world.job({ challengeEnd: NOW + 600 });
    world.tokenAccount(keeper.publicKey);
    world.tokenAccount(open.payee);
    world.tokenAccount(open.institution);
    const keeperCrank = crank();

    // Tur başında: iki job da challenge bitişinden beri bekliyor; en eskisi 300 s.
    expect(await keeperCrank.runOnce()).toEqual({ evaluated: 2, confirmed: 1 });
    expect(await value(metrics.dueJobs, 'keeper_due_jobs')).toBe(2);
    expect(keeperCrank.oldestDueSeconds()).toBe(300);
    // Politikasız iş challenge bitişinden 60 s sonra onaylandı.
    expect(await value(metrics.finalizeDelay, 'keeper_finalize_delay_seconds_sum', { gate: 'none' })).toBe(60);
    expect(await value(metrics.finalizeDelay, 'keeper_finalize_delay_seconds_count', { gate: 'none' })).toBe(1);

    // Onaylanan job ayna güncellenene kadar, ispat bekleyen job ispat gelene kadar birikimde değil.
    const paid = await world.client.escrow.fetch('job', open.address);
    await world.put('escrow', 'job', open.address, { ...paid!, status: { released: {} } });
    now += 10_000;
    await keeperCrank.runOnce();
    expect(await value(metrics.dueJobs, 'keeper_due_jobs')).toBe(0);
    expect(keeperCrank.oldestDueSeconds()).toBe(0);

    const indexedAt = now + 1_000;
    await db.client.releaseProof.create({
      data: {
        address: world.client.pda.releaseProof(gated.address)[0].toBase58(),
        job: gated.address.toBase58(),
        institution: gated.institution.toBase58(),
        policy: gated.policy!.toBase58(),
        payee: gated.payee.toBase58(),
        verdict: 'compliant',
        refusalCode: 0,
        consumed: false,
        netAmount: (AMOUNT - FEE).toString(),
        proofTimestamp: BigInt(NOW),
        account: {},
        slot: 2n,
        indexedAt: new Date(indexedAt),
      },
    });
    const backlog = await createJournal(db.client).backlog(new Date(indexedAt + 5_000));
    expect(backlog).toEqual({ due: 1, oldestReadyAt: new Date(indexedAt) });
  });
});

describe('hatalar', () => {
  it('simülasyon: escrow’un bekleme hatası bekletir, diğer program hatası başarısız sayılır', async () => {
    world.tokenAccount(keeper.publicKey);
    const waiting = await world.job();
    const broken = await world.job();
    rpc.simulations.push(failing(escrowError('proofRequired')), failing(escrowError('mathOverflow')));
    await crank().runOnce();
    const outcomes = [
      ...(await actions(waiting.address.toBase58())),
      ...(await actions(broken.address.toBase58())),
    ].map((a) => [a.outcome, a.reason]);
    expect(outcomes.sort()).toEqual([
      ['failed', 'programError'],
      ['skipped', 'proofRequired'],
    ]);
    expect(errors).toBe(1);
    expect(rpc.sent).toHaveLength(0);
  });

  it('onay hatası ve RPC kesintisi: başarısız kaydedilir, tur diğer job’la sürer', async () => {
    world.tokenAccount(keeper.publicKey);
    const rejected = await world.job();
    rpc.confirmation = { InstructionError: [2, { Custom: 1 }] };
    await crank().runOnce();
    expect((await actions(rejected.address.toBase58())).map((a) => [a.outcome, a.reason])).toEqual([
      ['submitted', null],
      ['failed', 'programError'],
    ]);

    await db.client.keeperAction.deleteMany();
    rpc.confirmation = null;
    rpc.failing.add('getFeeForMessage');
    const unreachable = await world.job();
    expect(await crank().runOnce()).toMatchObject({ confirmed: 0 });
    expect((await actions(unreachable.address.toBase58()))[0]).toMatchObject({ outcome: 'failed', reason: 'rpcError' });
  });

  it('onaylanmadan blockhash’in süresi dolarsa RPC hatası sayılır', async () => {
    world.tokenAccount(keeper.publicKey);
    const job = await world.job();
    rpc.confirmation = 'pending';
    const keeperCrank = crank();
    const round = keeperCrank.runOnce();
    // Yükseklik, finalize tx'i gönderildikten (blockhash'i alındıktan) sonra artmalı.
    while (rpc.sent.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    rpc.blockHeight += 1_000;
    await round;
    expect((await actions(job.address.toBase58())).map((a) => a.reason)).toEqual([null, 'rpcError']);
  });

  it('escrow config yoksa tur hata verir', async () => {
    rpc.accounts.clear();
    await expect(crank().runOnce()).rejects.toThrow(/escrow config/);
  });
});

describe('programlar', () => {
  it('programs tablosu: dört program ve aynı IDL sürümü olmalı', async () => {
    const { loadProgramIds } = await import('../src/programs.js');
    const { SQUARE_IDLS } = await import('@squaresdk/solana-sdk');
    await expect(loadProgramIds(db.client)).rejects.toThrow(/programs tablosunda yok/);
    await db.client.program.createMany({
      data: (['registry', 'policy', 'verifier', 'escrow'] as const).map((name) => ({
        name,
        programId: PROGRAM_IDS[name].toBase58(),
        idlVersion: SQUARE_IDLS[name].metadata.version,
      })),
    });
    expect((await loadProgramIds(db.client)).escrow.equals(PROGRAM_IDS.escrow)).toBe(true);
    await db.client.program.update({ where: { name: 'policy' }, data: { idlVersion: '9.9.9' } });
    await expect(loadProgramIds(db.client)).rejects.toThrow(/policy: IDL sürümü 9\.9\.9/);
  });
});
