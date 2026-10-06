// Lapse crank'i uçtan uca (BE-22): aday seçimi (dispute aynası), zincir doğrulaması, simülasyon, gönderim ve
// onay, günlük ve yeniden göndermeme. Veritabanı gerçek Postgres (Testcontainers), zincir yerel fixture RPC.
import type { BorshInstructionCoder } from '@anchor-lang/core';
import { Keypair } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createLogger } from '@squaresdk/solana-observability';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCrank } from '../src/crank.js';
import { createJournal, createLapseJournal } from '../src/journal.js';
import { classifyLapseFailure, createLapseCrank, type LapseCrank } from '../src/lapse.js';
import { createMetrics, type KeeperMetrics } from '../src/metrics.js';
import { createStateReader } from '../src/state.js';
import { FixtureRpc, startRpc, type RpcServer } from './fixtures/rpc.js';
import { NOW, PROGRAM_IDS, World } from './fixtures/world.js';

let db: IsolatedDatabase;
let rpc: FixtureRpc;
let server: RpcServer;
let world: World;
let keeper: Keypair;
let now: number;
let errors: number;
let metrics: KeeperMetrics;

const BACKOFF = { baseSeconds: 60, maxSeconds: 3_600 };

function lapseCrank(): LapseCrank {
  metrics = createMetrics({ service: 'keeper-test', version: '0.0.0' });
  return createLapseCrank({
    client: world.client,
    connection: world.client.registry.program.provider.connection,
    journal: createLapseJournal(db.client),
    keeper,
    fees: { priorityFeePercentile: 50, maxComputeUnitPrice: 10_000n },
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
    err: { InstructionError: [1, { Custom: code }] },
    logs: [`Program ${escrow} invoke [1]`, `Program ${escrow} failed: custom program error: 0x${code.toString(16)}`],
  };
};
const actions = (job: string) =>
  db.client.keeperAction.findMany({ where: { job }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });

/** Gönderilen tx'teki escrow talimatı: ad ve hesaplar. */
function sentLapse(index: number) {
  const tx = rpc.sent[index]!;
  const keys = tx.message.staticAccountKeys;
  const ix = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(PROGRAM_IDS.escrow))!;
  const name = (world.programs.escrow.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data))!.name;
  const def = world.programs.escrow.idl.instructions.find((i) => i.name === name)!;
  return {
    name,
    accounts: Object.fromEntries(def.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]!]!.toBase58()])),
  };
}

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

describe('lapse', () => {
  it('son tarihi geçmiş dispute lapse edilir: bond vault’u ve kurumun hesabı, onay günlükte, yeniden gönderilmez', async () => {
    const due = await world.disputed({ deadline: NOW - 10, bond: 5_000_000n });
    await world.disputed({ deadline: NOW + 3_600 });
    rpc.prioritizationFees = [10, 30, 20];
    const crank = lapseCrank();
    expect(await crank.runOnce()).toEqual({ evaluated: 1, confirmed: 1 });
    expect(rpc.sent).toHaveLength(1);
    const lapse = sentLapse(0);
    expect(lapse.name).toBe('lapseDispute');
    expect(lapse.accounts).toMatchObject({
      caller: keeper.publicKey.toBase58(),
      job: due.address.toBase58(),
      bondVault: world.client.pda.bondVault(due.address)[0].toBase58(),
      rentPayer: due.institution.toBase58(),
    });
    expect(rpc.sent[0]!.message.staticAccountKeys[0]!.equals(keeper.publicKey)).toBe(true);

    const journal = await actions(due.address.toBase58());
    expect(journal.map((a) => [a.action, a.outcome, a.reason])).toEqual([
      ['lapseDispute', 'submitted', null],
      ['lapseDispute', 'confirmed', null],
    ]);
    expect(journal[1]!.signature).toBe(journal[0]!.signature);
    expect(journal[1]!.nextAttemptAt!.getTime()).toBeGreaterThan(now);
    expect(await metrics.registry.metrics()).toContain(
      'keeper_actions_total{action="lapseDispute",outcome="confirmed",reason="none",service="keeper-test"} 1',
    );

    // Ayna henüz güncellenmedi: bekleme süresince aday değil; süre geçince zincir doğrulaması atlar.
    expect(await crank.runOnce()).toEqual({ evaluated: 0, confirmed: 0 });
    await world.put('escrow', 'job', due.address, { ...due.value, status: { delivered: {} } });
    now += (BACKOFF.baseSeconds + 1) * 1000;
    expect(await crank.runOnce()).toEqual({ evaluated: 1, confirmed: 0 });
    expect(rpc.sent).toHaveLength(1);
    expect(await actions(due.address.toBase58())).toHaveLength(2);
  });

  it('bond’suz başvuruda bond vault’u verilmez; zincirdeki son tarih gelmediyse son tarihe kadar beklenir', async () => {
    const escalated = await world.disputed({ deadline: NOW - 1 });
    // Ayna eski bir son tarih gösteriyor; zincirdeki dispute yeni (yeniden açılmış).
    const reopened = await world.disputed({ deadline: NOW + 500, mirrorDeadline: NOW - 5 });
    const crank = lapseCrank();
    expect(await crank.runOnce()).toEqual({ evaluated: 2, confirmed: 1 });
    expect(sentLapse(0).accounts.bondVault).toBe(PROGRAM_IDS.escrow.toBase58());
    expect(sentLapse(0).accounts.job).toBe(escalated.address.toBase58());
    const waiting = await actions(reopened.address.toBase58());
    expect(waiting.map((a) => [a.outcome, a.reason])).toEqual([['skipped', 'challengeOpen']]);
    expect(waiting[0]!.nextAttemptAt!.getTime()).toBe((NOW + 500) * 1000);
  });

  it('simülasyon hataları: zincir saati geride beklenir, dispute kapanmışsa atlanır, diğerleri programError', async () => {
    const a = await world.disputed({ deadline: NOW - 30 });
    const b = await world.disputed({ deadline: NOW - 20 });
    const c = await world.disputed({ deadline: NOW - 10 });
    rpc.simulations.push(
      failing(escrowError('disputeNotExpired')),
      failing(escrowError('noActiveDispute')),
      failing(escrowError('mintMismatch')),
    );
    expect(await lapseCrank().runOnce()).toEqual({ evaluated: 3, confirmed: 0 });
    expect(rpc.sent).toHaveLength(0);
    expect((await actions(a.address.toBase58())).map((x) => [x.outcome, x.reason])).toEqual([
      ['skipped', 'challengeOpen'],
    ]);
    expect(await actions(b.address.toBase58())).toHaveLength(0);
    expect((await actions(c.address.toBase58())).map((x) => [x.outcome, x.reason])).toEqual([
      ['failed', 'programError'],
    ]);
    expect(errors).toBe(1);
    expect(classifyLapseFailure(null)).toEqual({ kind: 'failed', reason: 'programError' });
  });

  it('onaylanan tx hatası, düşen tx ve RPC kesintisi geri çekilmeyle yeniden denenir', async () => {
    const job = await world.disputed({ deadline: NOW - 10 });
    rpc.confirmation = { InstructionError: [1, { Custom: 1 }] };
    const crank = lapseCrank();
    await crank.runOnce();
    rpc.confirmation = 'pending';
    now += (BACKOFF.baseSeconds + 1) * 1000;
    const round = crank.runOnce();
    // Yükseklik, tx gönderildikten (blockhash'i alındıktan) sonra artmalı.
    while (rpc.sent.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    rpc.blockHeight += 1_000;
    await round;
    rpc.failing.add('getRecentPrioritizationFees');
    now += 2 * BACKOFF.baseSeconds * 1000;
    await crank.runOnce();
    const journal = await actions(job.address.toBase58());
    expect(journal.map((a) => [a.outcome, a.reason])).toEqual([
      ['submitted', null],
      ['failed', 'programError'],
      ['submitted', null],
      ['failed', 'rpcError'],
      ['failed', 'rpcError'],
    ]);
    // Aynı sebeple ardışık ikinci hata iki katı bekler.
    expect(journal[4]!.nextAttemptAt!.getTime() - journal[4]!.at.getTime()).toBe(2 * BACKOFF.baseSeconds * 1000);
    expect(crank.lastSuccessAt()).toBe(now);
  });

  it('finalize ve lapse günlükleri birbirini bekletmez', async () => {
    const disputed = await world.disputed({ deadline: NOW - 10 });
    const lapseJournal = createLapseJournal(db.client);
    await lapseJournal.write(
      {
        job: disputed.address.toBase58(),
        outcome: 'skipped',
        reason: 'challengeOpen',
        nextAttemptAt: new Date(now + 60_000),
      },
      new Date(now),
    );
    expect(await lapseJournal.candidates(new Date(now), 10)).toEqual([]);
    expect(await lapseJournal.consecutive(disputed.address.toBase58(), 'challengeOpen')).toBe(1);
    expect(await createJournal(db.client).consecutive(disputed.address.toBase58(), 'challengeOpen')).toBe(0);

    // Finalize'a hazır job'un lapse kaydı (aynı adres) finalize adaylığını etkilemez.
    const ready = await world.job();
    await lapseJournal.write(
      { job: ready.address.toBase58(), outcome: 'confirmed', reason: null, nextAttemptAt: new Date(now + 60_000) },
      new Date(now),
    );
    const finalize = createCrank({
      client: world.client,
      connection: world.client.registry.program.provider.connection,
      reader: createStateReader({
        client: world.client,
        connection: world.client.registry.program.provider.connection,
      }),
      journal: createJournal(db.client),
      keeper,
      economics: {
        mintUnitsPerSol: 150_000_000n,
        minMarginBps: 0,
        priorityFeePercentile: 75,
        maxComputeUnitPrice: 50_000n,
      },
      backoff: BACKOFF,
      batchSize: 10,
      confirmPollMs: 5,
      metrics: createMetrics({ service: 'keeper-test', version: '0.0.0' }),
      log: createLogger({ service: 'keeper-test', level: 'error' }),
      onError: () => undefined,
      clock: () => now,
    });
    expect((await finalize.runOnce()).evaluated).toBe(1);
  });
});
