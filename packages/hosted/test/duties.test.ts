// Duty'ler (benzetim zinciri, sahte saat ve sahte API): crank yalnızca kurumun job'larında execute_resolution ve son
// tarihi geçmiş dispute'ta lapse_dispute gönderir; ispat bağlama politikaya bağlı her job'a bir izleyici açar ve
// kurumun yerel politikası, salt'ları ve prover'ıyla imzalayıp gönderir.
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { WatchJobProofParams } from '@squaresdk/solana-policy';
import type { BuiltTx, SquareApi } from '@squaresdk/solana-sdk';
import type { JobView } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { DutiesConfigSchema, type DutiesConfig } from '../src/config.js';
import { buildLapseDisputeTx, createDuties, type DutyAction, type DutiesOptions } from '../src/duties.js';
import { createMemoryLedger, type DelegationLedger } from '../src/ledger.js';
import { policyDocument } from './helpers/config.js';
import { SimChain, type JobFields } from './helpers/sim.js';

let sim: SimChain;
let ledger: DelegationLedger;
const institution = Keypair.generate();
const record = Keypair.generate().publicKey;
const wallet = Keypair.generate().publicKey;
const policyAccount = Keypair.generate().publicKey;
const NOW = 1_791_201_600;

const dutiesConfig = (overrides: Record<string, unknown> = {}): DutiesConfig =>
  DutiesConfigSchema.parse({
    intervalMs: 20,
    discovery: { api: false },
    crank: { executeResolution: true, lapseDispute: true },
    ...overrides,
  });

const policyWatch = {
  policySecretPath: '/dev/null',
  paymentCategory: 'research',
  intervalMs: 50,
  prover: { baseUrl: 'https://prover.square.test', apiKeyEnv: 'PROVER_API_KEY', artifactVersion: 'v1' },
};

async function job(fields: Partial<JobFields> = {}, owner = institution.publicKey): Promise<PublicKey> {
  const address = Keypair.generate().publicKey;
  await sim.setJob(address, {
    institution: owner,
    agentRecord: record,
    agentWallet: wallet,
    amount: 1_000_000n,
    specHash: '22'.repeat(32),
    status: 'delivered',
    deadline: NOW + 3_600,
    ...fields,
  });
  ledger.put({
    job: address.toBase58(),
    agentRecord: record.toBase58(),
    amount: '1000000',
    category: 'research',
    specHash: '22'.repeat(32),
    day: NOW - (NOW % 86_400),
    createdAt: NOW,
    status: 'funded',
  });
  return address;
}

function duties(overrides: Partial<DutiesOptions> = {}) {
  const actions: DutyAction[] = [];
  const errors: unknown[] = [];
  const item = createDuties({
    client: sim.client,
    connection: sim.connection(),
    commitment: 'confirmed',
    config: dutiesConfig(),
    signer: institution,
    ledger,
    now: () => sim.clock,
    onError: (error) => errors.push(error),
    onAction: (action) => actions.push(action),
    ...overrides,
  });
  return { item, actions, errors };
}

beforeEach(async () => {
  sim = new SimChain();
  sim.clock = NOW;
  await sim.setConfig();
  ledger = createMemoryLedger();
});

describe('crank', () => {
  it('Resolved job’da execute_resolution; kurumun imzasıyla, ücreti kurum öder', async () => {
    const resolved = await job({ status: 'resolved' });
    const { item, actions, errors } = duties();
    await item.tick();
    expect(errors).toEqual([]);
    expect(sim.sent.map((ix) => ix.name)).toEqual(['executeResolution']);
    expect(sim.sent[0]!.accounts.payer!.equals(institution.publicKey)).toBe(true);
    expect(sim.jobStatus(resolved)).toBe('released');
    expect(actions).toEqual([
      expect.objectContaining({ duty: 'crank', action: 'executeResolution', job: resolved.toBase58() }),
    ]);
    // Sonraki turda iş kalmadı.
    await item.tick();
    expect(sim.sent).toHaveLength(1);
  });

  it('lapse_dispute yalnızca dispute son tarihinden sonra; bond kuruma, iş Delivered’a döner', async () => {
    const disputed = await job({ status: 'disputed', dispute: { bond: 500_000n, deadline: NOW + 600 } });
    const { item, actions } = duties();
    await item.tick();
    expect(sim.sent).toEqual([]);
    sim.clock = NOW + 600;
    await item.tick();
    expect(sim.sent.map((ix) => ix.name)).toEqual(['lapseDispute']);
    const sent = sim.sent[0]!;
    expect(sent.accounts.bondVault!.equals(sim.client.pda.bondVault(disputed)[0])).toBe(true);
    expect(sim.other).toHaveLength(1); // kurumun token hesabı idempotent açılır
    expect(sim.jobStatus(disputed)).toBe('delivered');
    expect(sim.job(disputed)!.dispute.lapsed).toBe(true);
    expect(actions.map((a) => a.action)).toEqual(['lapseDispute']);
  });

  it('başka kurumun job’u ve kapalı adımlar atlanır; hata diğer job’ları durdurmaz', async () => {
    await job({ status: 'resolved' }, Keypair.generate().publicKey);
    const missing = Keypair.generate().publicKey.toBase58();
    ledger.put({ ...ledger.get(ledger.jobs()[0]!)!, job: missing });
    const resolved = await job({ status: 'resolved' });
    await job({ status: 'disputed', dispute: { bond: 0n, deadline: NOW - 1 } });
    const off = duties({ config: dutiesConfig({ crank: { executeResolution: false, lapseDispute: false } }) });
    await off.item.tick();
    expect(sim.sent).toEqual([]);

    sim.failure = (name) => (name === 'lapseDispute' ? new Error('rpc düştü') : null);
    const { item, errors } = duties();
    await item.tick();
    expect(sim.sent.map((ix) => ix.name)).toEqual(['executeResolution']);
    expect(sim.jobStatus(resolved)).toBe('released');
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/lapseDispute: rpc düştü/);
  });

  it('bond’suz dispute’ta bond vault verilmez', async () => {
    const address = await job({ status: 'disputed', dispute: { bond: 0n, deadline: NOW - 1 } });
    const built: BuiltTx = await buildLapseDisputeTx(
      sim.client,
      sim.connection(),
      { caller: institution.publicKey, job: address },
      { feePayer: institution.publicKey },
    );
    built.transaction.sign([institution]);
    await sim.connection().sendRawTransaction(built.transaction.serialize());
    expect(sim.sent[0]!.accounts.bondVault!.equals(sim.client.pda.bondVault(address)[0])).toBe(false);
    await expect(
      buildLapseDisputeTx(
        sim.client,
        sim.connection(),
        { caller: institution.publicKey, job: Keypair.generate().publicKey },
        {
          feePayer: institution.publicKey,
        },
      ),
    ).rejects.toThrow(/job bulunamadı/);
  });
});

describe('ispat bağlama (policy watch)', () => {
  const prover = { prove: async () => ({}) as never };
  const salts = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));

  it('politikaya bağlı, bitmemiş job’a bir kez izleyici; yerel politika, salt ve prover; gönderim kurumun imzasıyla', async () => {
    const policy = policyDocument(sim.settlementMint.toBase58());
    const watched = await job({ status: 'delivered', policy: policyAccount });
    await job({ status: 'delivered', policy: null });
    await job({ status: 'released', policy: policyAccount });
    const started: WatchJobProofParams[] = [];
    let stops = 0;
    const { item, actions } = duties({
      config: dutiesConfig({ crank: undefined, policyWatch }),
      proofs: { policy, salts, prover },
      watch: (params) => {
        started.push(params);
        return () => (stops += 1);
      },
    });
    await item.tick();
    await item.tick();
    expect(started).toHaveLength(1);
    const params = started[0]!;
    expect(params.job.equals(watched)).toBe(true);
    expect(params.policy).toBe(policy);
    expect(params.salts).toBe(salts);
    expect(params.prover).toBe(prover);
    expect(params.paymentCategory).toBe('research');
    expect(params.intervalMs).toBe(50);
    expect(params.authority.equals(institution.publicKey)).toBe(true);
    expect(params.buildOptions.feePayer.equals(institution.publicKey)).toBe(true);
    expect(item.watching()).toEqual([watched.toBase58()]);

    params.onRefreshed!({ signature: 'sig-1', witness: {} as never, reason: 'ispat yok' });
    params.onDone!('job released');
    expect(item.watching()).toEqual([]);
    expect(actions.map((a) => a.action)).toEqual(['watchStarted', 'proofRefreshed', 'watchDone']);
    item.stop();
    expect(stops).toBe(0);
  });

  it('izleyicinin gönderimi kurumun keypair’iyle imzalar; stop izleyicileri durdurur', async () => {
    await job({ status: 'accepted', policy: policyAccount });
    let submit: WatchJobProofParams['submit'] | null = null;
    let stopped = 0;
    const { item } = duties({
      config: dutiesConfig({ crank: undefined, policyWatch }),
      proofs: { policy: policyDocument(sim.settlementMint.toBase58()), salts, prover },
      watch: (params) => {
        submit = params.submit;
        return () => (stopped += 1);
      },
    });
    await item.tick();
    // İzleyicinin kurduğu tx (burada lapse_dispute) kurumun keypair'iyle imzalanıp gönderilir.
    const disputed = await job({ status: 'disputed', dispute: { bond: 0n, deadline: NOW - 1 } });
    const built = await buildLapseDisputeTx(
      sim.client,
      sim.connection(),
      { caller: institution.publicKey, job: disputed },
      { feePayer: institution.publicKey },
    );
    expect(await submit!(built)).toMatch(/^sim/);
    expect(sim.sent[0]!.signers).toEqual([institution.publicKey.toBase58()]);
    const other = Keypair.generate();
    const foreign = await sim.client.buildTx([], { feePayer: other.publicKey });
    await expect(submit!(foreign)).rejects.toThrow(/başka imzacı gerekiyor/);
    item.stop();
    expect(stopped).toBe(1);
    expect(item.watching()).toEqual([]);
  });

  it('policyWatch politika ve prover olmadan kurulmaz', () => {
    expect(() => duties({ config: dutiesConfig({ policyWatch }) })).toThrow(/politika, salt ve prover/);
  });
});

describe('keşif ve döngü', () => {
  function fakeApi(views: Record<string, string[]>, fail = false): { api: SquareApi; calls: unknown[] } {
    const calls: unknown[] = [];
    const api = {
      listJobs: async (query: { status: string; page: number; limit: number; institution: string }) => {
        calls.push(query);
        if (fail) {
          return { success: false, data: null, error: { code: 'internal', message: 'kapalı' }, meta: {} };
        }
        const all = views[query.status] ?? [];
        const data = all
          .slice((query.page - 1) * query.limit, query.page * query.limit)
          .map((address) => ({ address }) as JobView);
        return {
          success: true,
          data,
          error: null,
          meta: { requestId: 'r', page: query.page, limit: query.limit, total: all.length },
        };
      },
    } as unknown as SquareApi;
    return { api, calls };
  }

  it('API’den kurumun job’ları sayfalanarak okunur; zincirde kurum yine denetlenir', async () => {
    const resolved = await job({ status: 'resolved' });
    ledger.remove(resolved.toBase58());
    const foreign = await job({ status: 'resolved' }, Keypair.generate().publicKey);
    ledger.remove(foreign.toBase58());
    const filler = Array.from({ length: 150 }, () => Keypair.generate().publicKey.toBase58());
    const { api, calls } = fakeApi({ resolved: [resolved.toBase58(), foreign.toBase58(), ...filler] });
    const { item, errors } = duties({ config: dutiesConfig({ discovery: { api: true } }), api });
    await item.tick();
    expect(errors).toEqual([]);
    expect(sim.sent.map((ix) => ix.name)).toEqual(['executeResolution']);
    expect(sim.jobStatus(resolved)).toBe('released');
    expect(sim.jobStatus(foreign)).toBe('resolved');
    expect(calls).toEqual([
      { institution: institution.publicKey.toBase58(), status: 'disputed', page: 1, limit: 100 },
      { institution: institution.publicKey.toBase58(), status: 'resolved', page: 1, limit: 100 },
      { institution: institution.publicKey.toBase58(), status: 'resolved', page: 2, limit: 100 },
    ]);
  });

  it('API hatası raporlanır, defterdeki job’larla devam edilir; start/stop döngüsü', async () => {
    const resolved = await job({ status: 'resolved' });
    const { api } = fakeApi({}, true);
    const { item, errors } = duties({ config: dutiesConfig({ discovery: { api: true } }), api });
    item.start();
    item.start();
    const deadline = Date.now() + 2_000;
    while (sim.jobStatus(resolved) !== 'released' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    item.stop();
    expect(sim.jobStatus(resolved)).toBe('released');
    expect(String(errors[0])).toMatch(/job keşfi: internal: kapalı/);
  });
});
