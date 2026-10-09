import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { chainTime } from '@squaresdk/solana-smoke/chain';
import { buildOptions } from '@squaresdk/solana-smoke/context';
import type { Section, SmokeReport } from '@squaresdk/solana-smoke/render';
import { runSmoke } from '@squaresdk/solana-smoke/smoke';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chainEventKeys } from '../src/chain.js';
import { SERVICE_NAMES } from '../src/env.js';
import { diffEvents, eventNames } from '../src/events.js';
import { matching, metricSum, parseMetrics } from '../src/metrics.js';
import { worldOptions } from '../src/options.js';
import { startWorld, type World } from '../src/world.js';

const ENABLED = process.env['SQUARE_LOCALNET'] === '1';

const MIRRORED_TABLES = [
  'agent_reputations',
  'agents',
  'claims',
  'disputes',
  'institutions',
  'jobs',
  'policies',
  'release_proofs',
  'screenings',
  'validation_records',
];

const RUN_EVENTS = [
  'agentregistered',
  'buyerrootcommitted',
  'claimbought',
  'claimlisted',
  'complianceproofset',
  'fiatjobcreated',
  'institutioncreated',
  'jobaccepted',
  'jobcreated',
  'jobfunded',
  'mpppaymentverified',
  'policycommitted',
  'preflightproofset',
  'releaserecorded',
  'releaserefused',
  'releaseverified',
  'reputationrecorded',
  'screeningrecorded',
  'validationrecorded',
  'worksubmitted',
];

const variant = (value: object) => Object.keys(value)[0];

async function metrics(url: string) {
  const response = await fetch(`${url}/metrics`);
  if (!response.ok) throw new Error(`${url}/metrics: HTTP ${response.status}`);
  return parseMetrics(await response.text());
}

describe.skipIf(!ENABLED)('localnet: 8 adım servisler üzerinden (BE-36)', () => {
  let world: World;
  let report: SmokeReport;
  let failed = false;
  const jobs = new Map<Section | 'işaretli', PublicKey>();
  const job = (name: Section | 'işaretli') => {
    const address = jobs.get(name);
    if (!address) throw new Error(`${name} işi yok`);
    return address;
  };

  beforeAll(async () => {
    world = await startWorld(worldOptions(process.env));
  }, 900_000);

  beforeEach((context) => {
    context.onTestFailed(() => {
      failed = true;
    });
  });

  afterAll(async () => {
    if (!world) return;
    if (failed) process.stderr.write(`${world.logTails()}\n`);
    await world.close({ keepLogs: failed });
  }, 180_000);

  it('beş servis hazır: veritabanı, RPC, depo, OFAC listesi, registry yetkisi ve prover kapasitesi', async () => {
    for (const name of SERVICE_NAMES) {
      const response = await fetch(`${world.service(name).url}/ready`);
      expect(response.status, name).toBe(200);
    }
  });

  it('8 adım ve varyantlar: screening screener servisinden, finalize keeper servisinden, ispat-yok ispatı API ve prover servisinden', async () => {
    report = await runSmoke(world.context, {
      prover: world.provers.local,
      provers: { 'ispat-yok': world.provers.remote },
      screen: async (wallet) => {
        const decision = await world.screen(wallet);
        expect(decision.status).toBe('clear');
      },
      finalize: async (address, expectError) => {
        await world.waitForKeeper(address, expectError);
      },
    });
    for (const proof of report.proofs) jobs.set(proof.section, new PublicKey(proof.job));
    // Her bölümde önce kabul öncesi ön-ispat (ADR 0028), sonra release ispatı.
    const verdicts = (section: Section) =>
      report.proofs.filter((proof) => proof.section === section).map((proof) => proof.verdict);
    expect(
      Object.fromEntries((['akış', 'ispat-ret', 'ispat-yok', 'fiat'] as const).map((s) => [s, verdicts(s)])),
    ).toEqual({
      akış: ['ön-ispat', 'compliant'],
      'ispat-ret': ['ön-ispat', 'refused'],
      'ispat-yok': ['ön-ispat', 'compliant'],
      fiat: ['ön-ispat', 'compliant'],
    });
    expect(new Set(report.checks.map((check) => check.section))).toEqual(
      new Set(['akış', 'ispat-ret', 'ispat-yok', 'fiat']),
    );
    const prover = await metrics(world.service('prover').metricsUrl);
    // ispat-yok bölümünün iki ispatı (ön-ispat ve release) API ve prover servisinden.
    expect(metricSum(prover, 'prover_proofs_total', { result: 'ok' })).toBe(2);
  }, 1_200_000);

  it('screener işaretli tarafı zincire yazar; o tarafın işi fonlanamaz (ScreeningFlagged)', async () => {
    const { context, key, flagged } = world;
    const { client, connection, sender, config } = context;
    const decision = await world.screen(flagged.publicKey);
    expect(decision).toMatchObject({ wallet: flagged.publicKey.toBase58(), outcome: 'recorded', status: 'flagged' });
    const record = await client.registry.fetch('screeningRecord', client.pda.screeningRecord(flagged.publicKey)[0]);
    expect(record && variant(record.status)).toBe('flagged');

    const options = buildOptions(context, key.payer.publicKey);
    const agentId = `flagged-${Date.now()}`;
    await sender.send(
      '2',
      '`registerAgent` (cüzdanı işaretli)',
      () =>
        client.flow.registerAgent(
          {
            owner: key.agent.publicKey,
            agentId,
            agentCardUri: '',
            agentCardHash: new Uint8Array(32),
            wallet: flagged.publicKey,
          },
          options,
        ),
      [key.payer, key.agent],
    );
    const created: { job?: PublicKey } = {};
    const now = await chainTime(connection);
    await sender.send(
      '3',
      '`createJob` (işaretli agent)',
      async () => {
        const built = await client.flow.createJob(
          {
            institution: key.institution.publicKey,
            agentRecord: client.pda.agentRecord(key.agent.publicKey, agentId)[0],
            spec: { protocol: 'square-services-e2e/v1', task: 'işaretli tarafa iş' },
            amount: 1_000_000n,
            deadline: now + 3_600,
            challengePeriod: 5n,
          },
          options,
        );
        created.job = built.job;
        return built;
      },
      [key.payer, key.institution],
    );
    const flaggedJob = created.job!;
    const institutionAta = getAssociatedTokenAddressSync(config.settlementMint, key.institution.publicKey);
    const before = (await connection.getTokenAccountBalance(institutionAta)).value.amount;
    const refused = await sender.send(
      '3',
      '`fundJob` (işaretli agent)',
      () =>
        client.flow.fundJob(
          { institution: key.institution.publicKey, job: flaggedJob, institutionTokenAccount: institutionAta },
          options,
        ),
      [key.payer, key.institution],
      'screeningFlagged',
    );
    expect(refused.error).toMatchObject({ program: 'escrow', name: 'screeningFlagged' });
    const account = await client.escrow.fetch('job', flaggedJob);
    expect(account && variant(account.status)).toBe('open');
    expect((await connection.getTokenAccountBalance(institutionAta)).value.amount).toBe(before);
    jobs.set('işaretli', flaggedJob);
  }, 300_000);

  it("indexer zincirdeki bütün Square event'lerini yazar; API job görünümleri servislerin sonucunu gösterir", async () => {
    const { connection, client } = world.context;
    const tip = await connection.getSlot('confirmed');
    await world.until('son tx kesinleşti', 180_000, async () => (await connection.getSlot('finalized')) >= tip);
    const expected = await chainEventKeys(connection, client, world.programs);
    const stored = await world.until(
      "indexer'ın event'leri",
      180_000,
      async () => {
        const rows = await world.db.chainEvent.findMany({
          select: { signature: true, instructionIndex: true, eventIndex: true, program: true, name: true },
        });
        return diffEvents(expected, rows).missing.length === 0 ? rows : null;
      },
      {
        describe: async () => {
          const rows = await world.db.chainEvent.findMany();
          return `eksik: ${JSON.stringify(diffEvents(expected, rows).missing.slice(0, 10))}`;
        },
      },
    );
    expect(diffEvents(expected, stored)).toEqual({ missing: [], unexpected: [] });
    expect(eventNames(expected)).toEqual(expect.arrayContaining(RUN_EVENTS));
    process.stderr.write(
      `indexer: ${expected.length} event, ${new Set(expected.map((event) => event.signature)).size} tx, ` +
        `${eventNames(expected).length} event tipi; hepsi chain_events'te\n`,
    );

    const api = world.api();
    const view = async (name: Section | 'işaretli') => {
      const result = await api.getJob(job(name).toBase58());
      if (!result.success) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
      return result.data;
    };
    const main = await view('akış');
    expect(main.account.status).toBe('released');
    expect(main.payee).toBe(world.key.buyer.publicKey.toBase58());
    expect(main.claim?.status).toBe('settled');
    expect(main.validation?.outcome).toBe('verified');
    expect(main.releaseProof?.consumed).toBe(true);
    const refused = await view('ispat-ret');
    expect(refused.account.status).toBe('refunded');
    expect(refused.claim?.status).toBe('defaulted');
    expect(refused.validation?.outcome).toBe('refused');
    const waiting = await view('ispat-yok');
    expect(waiting.account.status).toBe('released');
    expect(waiting.payee).toBe(world.key.agent.publicKey.toBase58());
    expect((await view('fiat')).account.status).toBe('released');
    expect((await view('işaretli')).account.status).toBe('open');
  }, 600_000);

  it('keeper mutlu yolu finalize eder, ispatsız işte ProofRequired ile bekler, kesin retle kuruma iade eder', async () => {
    const { client, connection } = world.context;
    const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
    const amount = world.context.config.smoke!.jobAmount;
    const fee = String((amount * BigInt(config!.params.keeperFeeBps)) / 10_000n);

    const main = await world.keeperActions(job('akış'));
    const paid = main.find((action) => action.outcome === 'confirmed');
    expect(paid).toMatchObject({ action: 'finalizePayment', reason: null, keeperFee: fee });
    const tx = await connection.getTransaction(paid!.signature!, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    expect(tx?.meta?.err).toBeNull();
    expect(tx?.transaction.message.staticAccountKeys[0]?.equals(world.key.keeper.publicKey)).toBe(true);

    const waiting = await world.keeperActions(job('ispat-yok'));
    const released = waiting.find((action) => action.outcome === 'confirmed');
    const held = waiting.filter((action) => action.reason === 'proofRequired');
    expect(released).toMatchObject({ action: 'finalizePayment', keeperFee: fee });
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((action) => action.outcome === 'skipped' && action.at <= released!.at)).toBe(true);

    const refused = await world.keeperActions(job('ispat-ret'));
    expect(refused.find((action) => action.outcome === 'confirmed')).toMatchObject({
      action: 'finalizePayment',
      keeperFee: fee,
    });
    const events = await world.api().listEvents({ job: job('ispat-ret').toBase58(), name: 'ReleaseRefused' });
    expect(events.success && events.data.length).toBe(1);

    expect(await world.keeperActions(job('fiat'))).toEqual([]);
    expect(await world.keeperActions(job('işaretli'))).toEqual([]);
  });

  it("screener kararları denetim kaydında, indexer'ın aynasında ve API'de", async () => {
    const { key, flagged } = world;
    for (const [wallet, status] of [
      [key.institution.publicKey, 'clear'],
      [key.agent.publicKey, 'clear'],
      [key.buyer.publicKey, 'clear'],
      [flagged.publicKey, 'flagged'],
    ] as const) {
      const history = await world.screeningHistory(wallet);
      expect(history.map(({ trigger, outcome, status: decided }) => ({ trigger, outcome, status: decided }))).toEqual([
        { trigger: 'request', outcome: 'recorded', status },
      ]);
      expect(history[0]?.signature).toBeTruthy();
      const view = await world.api().getScreening(wallet.toBase58());
      if (!view.success) throw new Error(`${wallet.toBase58()}: ${view.error.code} ${view.error.message}`);
      expect(view.data.account.status).toBe(status);
      expect(view.data.fresh).toBe(status === 'clear');
    }
  });

  it('indexer uzlaştırması: yeniden açılan indexer zincir ile veritabanı arasında sapma bulmaz', async () => {
    const indexer = await world.restartIndexer(1);
    const samples = await world.until('ilk uzlaştırma', 120_000, async () => {
      const parsed = await metrics(indexer.metricsUrl);
      return metricSum(parsed, 'indexer_reconcile_runs_total') >= 1 ? parsed : null;
    });
    expect(metricSum(samples, 'indexer_reconcile_runs_total', { result: 'drift' })).toBe(0);
    expect(metricSum(samples, 'indexer_reconcile_runs_total', { result: 'error' })).toBe(0);
    expect(metricSum(samples, 'indexer_reconcile_runs_total', { result: 'clean' })).toBeGreaterThanOrEqual(1);
    const drift = matching(samples, 'indexer_reconcile_drift');
    expect(drift.map((sample) => sample.labels['table']).sort()).toEqual(MIRRORED_TABLES);
    expect(drift.every((sample) => sample.value === 0)).toBe(true);
    expect(metricSum(samples, 'indexer_reconcile_undecodable')).toBe(0);
  }, 300_000);
});
