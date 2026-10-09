// Zincirden witness, set_compliance_proof tx'i, uzak prover ve ispat tazeleme izleyicisi.
import { BN, type BorshInstructionCoder } from '@anchor-lang/core';
import { ComputeBudgetProgram, Ed25519Program, Keypair } from '@solana/web3.js';
import { mppAttestationMessage, TX_COMPUTE_UNIT_LIMITS, type BuiltTx } from '@squaresdk/solana-sdk';
import type { ProveResponse } from '@squaresdk/solana-types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteProver, type Prover } from '../src/prover.js';
import { buildSetComplianceProofTx, buildSetPreflightProofTx, buildVerifyMppPaymentProofTx } from '../src/tx.js';
import { watchJobProof, type MppAttestation } from '../src/watch.js';
import { dayStart } from '../src/release.js';
import { buildPreflightWitness, buildReleaseWitness, type ReleaseWitness } from '../src/witness.js';
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

describe('kabul öncesi ön-ispat (ADR 0028)', () => {
  const preflight = () =>
    buildPreflightWitness({
      client: state.client,
      job: world.job,
      policy: okPolicy,
      salts,
      paymentCategory: 'research',
      now: TIMESTAMP,
    });
  const refusal = (code: number) => code.toString(16).padStart(64, '0');

  it('işin kendi koşulları: net tutarın tamamı, payee agent (alacak satılmış görünse de), sayaç 0, makbuz 0', async () => {
    await state.job({ status: { funded: {} } });
    await state.claim('bought', Keypair.generate().publicKey);
    await state.operator(900_000_000n, dayStart(TIMESTAMP));
    const w = await preflight();
    expect(w.netAmount).toBe(JOB_AMOUNT);
    expect(w.payee.equals(world.agentWallet)).toBe(true);
    expect(w.dailySpentBefore).toBe(0n);
    expect(w.stripeReceiptHash).toBe(0n);
    expect(w.timestamp).toBe(TIMESTAMP);
    const proof = await localProver.prove(w);
    expect(await verify(proof)).toBe(true);
    expect(proof.publicInputs[0]).toBe(refusal(0));
  });

  it('set_preflight_proof: ispat, ret kodu ve an; hesaplar PDA; kalıcı ya da günlük tavan bitli ispat kurulmaz', async () => {
    await state.job({ status: { funded: {} } });
    const proof = await localProver.prove(await preflight());
    const params = { authority, institution: world.institution, policy: policyAccount, job: world.job, proof };
    const { name, args, accounts, computeUnitLimit } = decodeComplianceTx(
      await buildSetPreflightProofTx(state.client, params, { feePayer }),
    );
    expect(name).toBe('setPreflightProof');
    expect(computeUnitLimit).toBe(TX_COMPUTE_UNIT_LIMITS.setPreflightProof);
    expect(args.refusalCode).toBe(0);
    expect((args.proofTimestamp as BN).toNumber()).toBe(TIMESTAMP);
    expect(Buffer.from(args.proofA as number[]).toString('hex')).toBe(proof.proofA);
    const pda = state.client.pda;
    expect(accounts).toMatchObject({
      payer: feePayer.toBase58(),
      authority: authority.toBase58(),
      config: pda.verifierConfig()[0].toBase58(),
      institution: world.institution.toBase58(),
      policy: policyAccount.toBase58(),
      job: world.job.toBase58(),
      preflightProof: pda.preflightProof(world.job)[0].toBase58(),
    });
    // Zaman penceresi (32) ve kategori (16) geçicidir; işlem başı tavan (1) ve günlük tavan (64) değil.
    const withCode = (code: number) => ({ ...proof, publicInputs: [refusal(code), ...proof.publicInputs.slice(1)] });
    for (const code of [16, 32, 48]) {
      await expect(
        buildSetPreflightProofTx(state.client, { ...params, proof: withCode(code) }, { feePayer }),
      ).resolves.toBeDefined();
    }
    for (const code of [1, 2, 4, 8, 64]) {
      await expect(
        buildSetPreflightProofTx(state.client, { ...params, proof: withCode(code) }, { feePayer }),
      ).rejects.toThrow(/kalıcı ya da günlük tavan/);
    }
  });

  it('politikasız job ve yerel politikanın snapshot uyuşmazlığı hata verir', async () => {
    await state.job({ policy: null });
    await expect(preflight()).rejects.toThrow(/politikaya bağlı değil/);
    await state.job({ policyCommitment: Array.from(new Uint8Array(32)) });
    await expect(preflight()).rejects.toThrow(/commitment snapshot/);
  });
});

describe('fiat iş (BC-37, ADR 0024)', () => {
  const FIAT_AMOUNT = 30_000_000n;
  // Stripe makbuzunun Poseidon commitment'ı yerine test değeri: sıfırdan farklı bir alan elemanı.
  const RECEIPT = 0x062426892f0128f3ebafebd760832d8d50bd69034e2cec2ca7089303a0574e34n;
  const fiatWitness = (stripeReceiptHash?: bigint) =>
    buildReleaseWitness({
      client: state.client,
      job: world.job,
      policy: okPolicy,
      salts,
      paymentCategory: 'research',
      now: TIMESTAMP,
      ...(stripeReceiptHash === undefined ? {} : { stripeReceiptHash }),
    });

  beforeEach(async () => {
    await state.job({ rail: { fiat: {} }, amount: new BN(FIAT_AMOUNT.toString()) });
  });

  it('net tutarın tamamı, payee agent (alacak satılmış görünse de), makbuz commitment sinyal 12', async () => {
    await state.claim('bought', Keypair.generate().publicKey);
    const w = await fiatWitness(RECEIPT);
    expect(w.netAmount).toBe(FIAT_AMOUNT);
    expect(w.payee.equals(world.agentWallet)).toBe(true);
    expect(w.inputs.stripe_receipt_hash_in).toBe(RECEIPT.toString());
    await expect(fiatWitness()).rejects.toThrow(/stripeReceiptHash/);
    await expect(fiatWitness(0n)).rejects.toThrow(/stripeReceiptHash/);
    await state.job();
    await expect(fiatWitness(RECEIPT)).rejects.toThrow(/escrow işinin/);
  });

  it('verify_mpp_payment_proof: attestation hemen önceki talimat, ispat ve makbuz argüman, hesaplar PDA', async () => {
    const mpp = Keypair.generate();
    await state.verifierConfig(mpp.publicKey);
    const proof = await localProver.prove(await fiatWitness(RECEIPT));
    expect(await verify(proof)).toBe(true);
    const receipt = Buffer.from(RECEIPT.toString(16).padStart(64, '0'), 'hex');
    const message = mppAttestationMessage({ job: world.job, stripeReceiptHash: receipt, amount: FIAT_AMOUNT });
    const signed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: mpp.secretKey, message });
    const attestationSignature = signed.data.subarray(48, 112);
    const params = {
      authority,
      institution: world.institution,
      policy: policyAccount,
      job: world.job,
      proof,
      attestationSignature,
    };
    const tx = await buildVerifyMppPaymentProofTx(state.client, params, { feePayer });
    const { name, args, accounts, computeUnitLimit } = decodeComplianceTx(tx);
    expect(name).toBe('verifyMppPaymentProof');
    expect(computeUnitLimit).toBe(TX_COMPUTE_UNIT_LIMITS.verifyMppPaymentProof);
    expect(Buffer.from(args.stripeReceiptHash as number[])).toEqual(receipt);
    expect((args.proofTimestamp as BN).toNumber()).toBe(TIMESTAMP);
    const pda = state.client.pda;
    expect(accounts).toMatchObject({
      payer: feePayer.toBase58(),
      authority: authority.toBase58(),
      job: world.job.toBase58(),
      operatorState: pda.operatorState(world.institution)[0].toBase58(),
      releaseProof: pda.releaseProof(world.job)[0].toBase58(),
      instructions: 'Sysvar1nstructions1111111111111111111111111',
    });
    // Precompile talimatı verifier talimatından hemen önce ve imzalanan mesajı taşır.
    const message0 = tx.transaction.message;
    const keys = message0.staticAccountKeys;
    const programs = message0.compiledInstructions.map((ix) => keys[ix.programIdIndex]!);
    const at = programs.findIndex((p) => p.equals(state.client.verifier.program.programId));
    expect(programs[at - 1]!.equals(Ed25519Program.programId)).toBe(true);
    expect(Buffer.from(message0.compiledInstructions[at - 1]!.data)).toEqual(Buffer.from(signed.data));

    const refused = { ...proof, publicInputs: ['0'.repeat(63) + '1', ...proof.publicInputs.slice(1)] };
    await expect(
      buildVerifyMppPaymentProofTx(state.client, { ...params, proof: refused }, { feePayer }),
    ).rejects.toThrow(/uyumlu/);
    const noReceipt = { ...proof, publicInputs: [...proof.publicInputs.slice(0, 12), '0'.repeat(64)] };
    await expect(
      buildVerifyMppPaymentProofTx(state.client, { ...params, proof: noReceipt }, { feePayer }),
    ).rejects.toThrow(/sinyal 12/);
    await state.job();
    await expect(buildVerifyMppPaymentProofTx(state.client, params, { feePayer })).rejects.toThrow(/fiat rayında/);
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
  function run(quietMs = 150, now = TIMESTAMP, mppAttestation?: () => Promise<MppAttestation>) {
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
        ...(mppAttestation && { mppAttestation }),
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

  it('fiat iş: attestation verilmezse izlenmez; verilirse ispat verify_mpp_payment_proof ile bağlanır', async () => {
    const amount = 30_000_000n;
    await state.job({ rail: { fiat: {} }, amount: new BN(amount.toString()) });
    const mpp = Keypair.generate();
    await state.verifierConfig(mpp.publicKey);
    const missing = run(30_000);
    await missing.done;
    expect(String(missing.errors[0])).toMatch(/attestation'sız/);

    const receiptHash = Buffer.from('062426892f0128f3ebafebd760832d8d50bd69034e2cec2ca7089303a0574e34', 'hex');
    const message = mppAttestationMessage({ job: world.job, stripeReceiptHash: receiptHash, amount });
    const signed = Ed25519Program.createInstructionWithPrivateKey({ privateKey: mpp.secretKey, message });
    let reads = 0;
    const attestation = async () => {
      reads += 1;
      return { receiptHash, signature: signed.data.subarray(48, 112) };
    };
    const watch = run(30_000, TIMESTAMP, attestation);
    await watch.done;
    expect(watch.errors).toEqual([]);
    expect(watch.reasons).toEqual(['ispat yok']);
    expect(reads).toBe(1);
    expect(watch.proving[0]!.inputs.stripe_receipt_hash_in).toBe(BigInt(`0x${receiptHash.toString('hex')}`).toString());
    const { name, args } = decodeComplianceTx(watch.submitted[0]!);
    expect(name).toBe('verifyMppPaymentProof');
    expect(Buffer.from(args.stripeReceiptHash as number[])).toEqual(receiptHash);
    const message0 = watch.submitted[0]!.transaction.message;
    const keys = message0.staticAccountKeys;
    const programs = message0.compiledInstructions.map((ix) => keys[ix.programIdIndex]!);
    const at = programs.findIndex((p) => p.equals(state.client.verifier.program.programId));
    expect(Buffer.from(message0.compiledInstructions[at - 1]!.data)).toEqual(Buffer.from(signed.data));
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
