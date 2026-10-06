// Zincirden witness, set_compliance_proof tx'i, uzak prover ve ispat tazeleme izleyicisi.
import { BN, type BorshInstructionCoder } from '@anchor-lang/core';
import { ComputeBudgetProgram, Keypair } from '@solana/web3.js';
import { TX_COMPUTE_UNIT_LIMITS, type BuiltTx } from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteProver, type Prover } from '../src/prover.js';
import { buildSetComplianceProofTx } from '../src/tx.js';
import { watchJobProof } from '../src/watch.js';
import { dayStart } from '../src/release.js';
import { buildReleaseWitness, type ReleaseWitness } from '../src/witness.js';
import { localProver, verify } from './helpers/artifacts.js';
import { readCircuitJson, TIMESTAMP, USDC_DEVNET, world } from './helpers/circuit-world.js';
import { JOB_AMOUNT, okPolicy, policyAccount, salts, State } from './helpers/state.js';

let state: State;
const feePayer = Keypair.generate().publicKey;
const authority = world.institutionWallet;

beforeEach(async () => {
  state = new State();
  await state.ok();
});

afterAll(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const witness = (now = TIMESTAMP) =>
  buildReleaseWitness({
    client: state.client,
    job: world.job,
    policy: okPolicy,
    salts,
    paymentCategory: 'research',
    now,
  });

describe('buildReleaseWitness', () => {
  it('zincirdeki job, ücret ve sayaçtan devrenin ok_compliant girdisini kurar', async () => {
    const w = await witness();
    expect(w.inputs).toEqual(readCircuitJson('test-inputs/ok_compliant.json'));
    expect(w.netAmount).toBe(25_000_000n);
    expect(JOB_AMOUNT - w.netAmount).toBe(510_204n);
    expect(w.payee.equals(world.agentWallet)).toBe(true);
    expect(w.mint.equals(USDC_DEVNET)).toBe(true);
  });

  it('alacak satılmışsa payee alıcı; sayaç dünden kalmışsa 0', async () => {
    const buyer = Keypair.generate().publicKey;
    await state.claim('listed', buyer);
    expect((await witness()).payee.equals(world.agentWallet)).toBe(true);
    await state.claim('bought', buyer);
    expect((await witness()).payee.equals(buyer)).toBe(true);
    await state.operator(900_000_000n, Math.floor(TIMESTAMP / 86_400) * 86_400 - 86_400);
    expect((await witness()).dailySpentBefore).toBe(0n);
  });

  it('job yok, politikasız, snapshot uyuşmazlığı ve eksik hesaplar hata verir', async () => {
    await state.job({ policyCommitment: Array.from(new Uint8Array(32)) });
    await expect(witness()).rejects.toThrow(/commitment/);
    await state.job({ policyDailyCeiling: new BN(1) });
    await expect(witness()).rejects.toThrow(/tavan/);
    await state.job({ policy: null });
    await expect(witness()).rejects.toThrow(/politikaya bağlı değil/);
    const fresh = new State();
    await expect(
      buildReleaseWitness({
        client: fresh.client,
        job: world.job,
        policy: okPolicy,
        salts,
        paymentCategory: 'research',
      }),
    ).rejects.toThrow(/job bulunamadı/);
    await fresh.job();
    await expect(
      buildReleaseWitness({
        client: fresh.client,
        job: world.job,
        policy: okPolicy,
        salts,
        paymentCategory: 'research',
      }),
    ).rejects.toThrow(/politika hesabı/);
    await fresh.policy();
    await expect(
      buildReleaseWitness({
        client: fresh.client,
        job: world.job,
        policy: okPolicy,
        salts,
        paymentCategory: 'research',
      }),
    ).rejects.toThrow(/config/);
  });
});

function decodeComplianceTx(tx: BuiltTx) {
  const program = state.client.verifier.program;
  const message = tx.transaction.message;
  const keys = message.staticAccountKeys;
  const ix = message.compiledInstructions.find((i) => keys[i.programIdIndex]!.equals(program.programId))!;
  const decoded = (program.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data))!;
  const def = program.idl.instructions.find((i) => i.name === decoded.name)!;
  const accounts = Object.fromEntries(def.accounts.map((a, i) => [a.name, keys[ix.accountKeyIndexes[i]!]!.toBase58()]));
  // `SetComputeUnitLimit` (ComputeBudget talimatı 2, u32).
  const budget = message.compiledInstructions.find(
    (i) => keys[i.programIdIndex]!.equals(ComputeBudgetProgram.programId) && i.data[0] === 2,
  );
  const computeUnitLimit = budget ? Buffer.from(budget.data).readUInt32LE(1) : undefined;
  return { name: decoded.name, args: decoded.data as Record<string, unknown>, accounts, computeUnitLimit };
}

describe('buildSetComplianceProofTx', () => {
  it("ispatı ve üç sinyali taşır; hesaplar PDA'lardan", async () => {
    const proof = await localProver.prove(await witness());
    const tx = await buildSetComplianceProofTx(
      state.client,
      { authority, institution: world.institution, policy: policyAccount, job: world.job, proof },
      { feePayer },
    );
    const { name, args, accounts, computeUnitLimit } = decodeComplianceTx(tx);
    expect(name).toBe('setComplianceProof');
    // Groth16 doğrulaması talimat başına varsayılan 200 bine yakın: sınır profilden (BC-28).
    expect(computeUnitLimit).toBe(TX_COMPUTE_UNIT_LIMITS.setComplianceProof);
    expect(args.refusalCode).toBe(0);
    expect((args.netAmount as BN).toString()).toBe('25000000');
    expect((args.proofTimestamp as BN).toNumber()).toBe(TIMESTAMP);
    expect(Buffer.from(args.proofA as number[]).toString('hex')).toBe(proof.proofA);
    const pda = state.client.pda;
    expect(accounts).toMatchObject({
      payer: feePayer.toBase58(),
      authority: authority.toBase58(),
      institution: world.institution.toBase58(),
      policy: policyAccount.toBase58(),
      job: world.job.toBase58(),
      config: pda.verifierConfig()[0].toBase58(),
      claimListing: pda.claimListing(world.job)[0].toBase58(),
      operatorState: pda.operatorState(world.institution)[0].toBase58(),
      releaseProof: pda.releaseProof(world.job)[0].toBase58(),
    });
    const tooBig = { ...proof, publicInputs: ['0'.repeat(59) + '10000', ...proof.publicInputs.slice(1)] };
    await expect(
      buildSetComplianceProofTx(
        state.client,
        { authority, institution: world.institution, policy: policyAccount, job: world.job, proof: tooBig },
        { feePayer },
      ),
    ).rejects.toThrow(/u16/);
  });
});

describe('createRemoteProver', () => {
  it('POST /v1/prove, X-API-Key; zarfı ve artefakt sürümünü denetler', async () => {
    const w = await witness();
    const proof = await localProver.prove(w);
    const requests: { url: string; init: RequestInit }[] = [];
    const respond = (body: unknown) =>
      (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
    const meta = { requestId: 'r1', page: null, limit: null, total: null };
    const ok = createRemoteProver({
      baseUrl: 'https://api.square.test/',
      apiKey: 'key-1',
      artifactVersion: proof.artifactVersion,
      fetch: respond({ success: true, data: proof, error: null, meta }),
    });
    expect(await ok.prove(w)).toEqual(proof);
    expect(requests[0]!.url).toBe('https://api.square.test/v1/prove');
    expect((requests[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('key-1');
    expect(JSON.parse(String(requests[0]!.init.body))).toMatchObject({
      circuit: 'payment-compliance',
      artifactVersion: proof.artifactVersion,
    });

    const other = createRemoteProver({
      baseUrl: 'https://api.square.test',
      apiKey: 'k',
      artifactVersion: 'ab'.repeat(32),
      fetch: respond({ success: true, data: proof, error: null, meta }),
    });
    await expect(other.prove(w)).rejects.toThrow(/başka bir anahtar/);
    const error = { code: 'prover_unavailable', message: 'busy', programError: null, details: null };
    const failing = createRemoteProver({
      baseUrl: 'https://api.square.test',
      apiKey: 'k',
      artifactVersion: proof.artifactVersion,
      fetch: respond({ success: false, data: null, error, meta }),
    });
    await expect(failing.prove(w)).rejects.toThrow(/prover_unavailable/);
  });
});

describe('watchJobProof (bayatlamada otomatik yenileme)', () => {
  /** İzleyiciyi çalıştırır; yenileme, hata, kendiliğinden bitiş ya da `quietMs` sessizlik sonrası durur. */
  function run(quietMs = 150, now = TIMESTAMP) {
    const submitted: BuiltTx[] = [];
    const errors: unknown[] = [];
    const reasons: string[] = [];
    const done: string[] = [];
    // İzleyici ispatı bayat bulduğu anda prover'ı çağırır; ispatın üretimi sessizlik süresinden uzun sürebilir.
    const proving: ReleaseWitness[] = [];
    const prover: Prover = { prove: (w: ReleaseWitness) => (proving.push(w), localProver.prove(w)) };
    const finished = new Promise<void>((resolve) => {
      const stop = watchJobProof({
        client: state.client,
        prover,
        job: world.job,
        policy: okPolicy,
        salts,
        paymentCategory: 'research',
        authority,
        buildOptions: { feePayer },
        submit: async (tx) => {
          submitted.push(tx);
          return `sig-${submitted.length}`;
        },
        intervalMs: 5,
        onError: (e) => (errors.push(e), stop(), resolve()),
        onRefreshed: ({ reason }) => (reasons.push(reason), stop(), resolve()),
        onDone: (reason) => (done.push(reason), resolve()),
        now: () => now,
      });
      setTimeout(() => (stop(), resolve()), quietMs);
    });
    return { done: finished, submitted, errors, reasons, ended: done, proving };
  }

  const bound = async (overrides: Record<string, unknown> = {}) => {
    const w = await witness();
    await state.releaseProof({
      job: world.job,
      payee: w.payee,
      mint: w.mint,
      netAmount: new BN(w.netAmount.toString()),
      dailySpentBefore: new BN(w.dailySpentBefore.toString()),
      proofTimestamp: new BN(TIMESTAMP),
      consumed: false,
      ...overrides,
    });
  };

  it('ispat yoksa üretip bağlar; ispat doğrulanıyor', async () => {
    const watch = run(30_000);
    await watch.done;
    expect(watch.reasons).toEqual(['ispat yok']);
    expect(watch.submitted).toHaveLength(1);
    const { args } = decodeComplianceTx(watch.submitted[0]!);
    expect((args.netAmount as BN).toString()).toBe('25000000');
  });

  it('taze ispat varken bir şey göndermez', async () => {
    await bound();
    const watch = run(500);
    await watch.done;
    expect(watch.proving).toEqual([]);
    expect(watch.submitted).toEqual([]);
    expect(watch.errors).toEqual([]);
  });

  for (const [reason, change] of [
    ['günlük sayaç değişti', () => state.operator(300_000_000n)],
    ['payee değişti', () => state.claim('bought', Keypair.generate().publicKey)],
    ['net tutar değişti', () => bound({ netAmount: new BN(1) })],
    ['mint değişti', () => bound({ mint: Keypair.generate().publicKey })],
    ['gün değişti', () => bound({ proofTimestamp: new BN(dayStart(TIMESTAMP) - 60) })],
  ] as const) {
    it(`bayatlayınca yeniler: ${reason}`, async () => {
      await bound();
      await change();
      const watch = run(30_000);
      await watch.done;
      expect(watch.reasons).toEqual([reason]);
      expect(watch.submitted).toHaveLength(1);
    });
  }

  it('gece yarısından hemen sonra dünkü ispatı yeniler, sayaç aynı kalsa da (ADR 0012 §4)', async () => {
    // Dün 23:59'da yapılmış ispat, bugün 00:02'de: payee, net, mint ve sayaç aynı, release'in günü farklı.
    await bound({ proofTimestamp: new BN(dayStart(TIMESTAMP) - 60) });
    const watch = run(30_000, dayStart(TIMESTAMP) + 120);
    await watch.done;
    expect(watch.reasons).toEqual(['gün değişti']);
    expect(watch.submitted).toHaveLength(1);
  });

  it('aynı UTC gününde saatler önce yapılmış ispatı yenilemez: ispat gün sonuna kadar tazedir', async () => {
    await bound({ proofTimestamp: new BN(TIMESTAMP - 2 * 3600) });
    const watch = run(500);
    await watch.done;
    expect(watch.proving).toEqual([]);
    expect(watch.submitted).toEqual([]);
    expect(watch.errors).toEqual([]);
  });

  it("tüketilmiş ispatta, bitmiş job'da ve teslim edilmemiş job'da göndermez; hata onError'a gider", async () => {
    await bound({ consumed: true });
    const consumed = run(30_000);
    await consumed.done;
    expect([consumed.submitted, consumed.ended]).toEqual([[], ['ispat tüketildi']]);

    await state.job({ status: { released: {} } });
    const released = run(30_000);
    await released.done;
    expect([released.submitted, released.ended]).toEqual([[], ['job released']]);

    await state.job({ status: { accepted: {} } });
    const accepted = run();
    await accepted.done;
    expect([accepted.submitted, accepted.ended, accepted.errors]).toEqual([[], [], []]);

    const empty = new State();
    state = empty;
    const failing = run(30_000);
    await failing.done;
    expect(String(failing.errors[0])).toMatch(/job bulunamadı/);
  });

  it('yenilenen ispat release anahtarıyla doğrulanıyor', async () => {
    let captured: ProveResponse | undefined;
    const prover: Prover = {
      prove: async (w) => {
        captured = await localProver.prove(w);
        return captured;
      },
    };
    await new Promise<void>((resolve) => {
      const stop = watchJobProof({
        client: state.client,
        prover,
        job: world.job,
        policy: okPolicy,
        salts,
        paymentCategory: 'research',
        authority,
        buildOptions: { feePayer },
        submit: async () => 'sig',
        intervalMs: 5,
        onError: () => resolve(),
        onRefreshed: () => (stop(), resolve()),
        now: () => TIMESTAMP,
      });
    });
    expect(captured && (await verify(captured))).toBe(true);
  });
});
