// Uyum ispatı ve release durumu (FE-09): ret kodunun sebepleri, bayatlık sebepleri, escrow'un finalize'da
// ne yapacağı, kurumun bu tarayıcıdaki politikasının job'un snapshot'ıyla eşleşmesi, artefakt sürümü.
// Kuralların kendisi `@squaresdk/solana-policy`'de ve zincirdekilerle ortak vektörlerle test edilir. Ağ
// kullanılmaz; gerçek prover ve programlara karşı bağlama FE-09 PR'ındaki yerel validator denemesindedir.
import { readFileSync } from 'node:fs';
import BN from 'bn.js';
import { Keypair } from '@solana/web3.js';
import { computePolicyCommitment, derivePolicySalts, generatePolicySecret } from '@squaresdk/solana-policy';
import type { ClaimListingAccount, JobAccount } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { institutionAddress, policyAddress } from '@/lib/idl-pda';
import { draftDocument, hexToBytes, newDraft, type PolicyDraft } from '@/lib/policy-draft';
import {
  policyMaterialFor,
  proverErrorMessage,
  refusalReasons,
  RELEASE_ARTIFACT_VERSION,
  releaseOutlook,
  verifierErrorMessage,
  type ProofView,
  type ReleaseState,
} from '@/lib/release-proof';

const key = () => Keypair.generate().publicKey;
const [agent, buyer, mint, institution] = [key(), key(), key(), key()];
const DAY = 86_400;
const noon = 1_790_000_000 - (1_790_000_000 % DAY) + DAY / 2;

const job = (fields: Partial<JobAccount> = {}) =>
  ({
    agentWallet: agent,
    institution,
    mint,
    amount: new BN(250_000_000),
    status: { delivered: {} },
    policy: key(),
    ...fields,
  }) as JobAccount;
const proof = (fields: Partial<ProofView> = {}): ProofView => ({
  payee: agent,
  netAmount: 248_750_000n,
  mint,
  dailySpentBefore: 0n,
  proofTimestamp: noon,
  compliant: true,
  refusalCode: 0,
  consumed: false,
  ...fields,
});
const state = (p: ProofView | null, operator: ReleaseState['operator'] = null): ReleaseState => ({
  proof: p,
  operator,
  keeperFeeBps: 50,
  institution: key(),
  multisigVault: null,
});

describe('refusal code', () => {
  it('names every rule the proof refused', () => {
    expect(refusalReasons(0)).toEqual([]);
    expect(refusalReasons(8 | 16)).toEqual(['The payee is on the blocked list', 'The payment category is not allowed']);
    expect(refusalReasons(64)).toEqual(['The amount would exceed the public daily ceiling']);
  });
});

describe('freshness', () => {
  it('tells what the escrow does at finalize now', () => {
    const operator = { dailySpent: 0n, dayStartUnix: noon - DAY / 2 };
    expect(releaseOutlook(state(null), job(), null, noon).kind).toBe('noProof');
    expect(releaseOutlook(state(proof(), operator), job(), null, noon + 60).kind).toBe('pays');
    expect(releaseOutlook(state(proof({ consumed: true }), operator), job(), null, noon).kind).toBe('consumed');
    const refunds = releaseOutlook(state(proof({ compliant: false, refusalCode: 8 }), operator), job(), null, noon);
    expect(refunds).toMatchObject({ kind: 'refunds', reasons: ['The payee is on the blocked list'] });
    const waits = releaseOutlook(state(proof({ compliant: false, refusalCode: 16 }), operator), job(), null, noon);
    expect(waits).toMatchObject({ kind: 'waits', reasons: ['The payment category is not allowed'] });
  });

  it('names why a proof went stale', () => {
    const operator = { dailySpent: 0n, dayStartUnix: noon - DAY / 2 };
    const sold = { buyer, status: { bought: {} } } as ClaimListingAccount;
    expect(releaseOutlook(state(proof(), operator), job(), sold, noon)).toMatchObject({
      kind: 'stale',
      reasons: ['The receivable was sold after the proof was made, so the payee is now the buyer.'],
    });
    expect(releaseOutlook(state(proof(), operator), job(), null, noon + DAY)).toMatchObject({
      kind: 'stale',
      reasons: ['A new UTC day started; the proof only pays out on the day it was made.'],
    });
    const moved = { dailySpent: 100_000_000n, dayStartUnix: noon - DAY / 2 };
    expect(releaseOutlook(state(proof(), moved), job(), null, noon)).toMatchObject({
      kind: 'stale',
      reasons: ["Another release moved the institution's daily counter after the proof was made."],
    });
    expect(releaseOutlook(state(proof({ netAmount: 1n }), operator), job(), null, noon)).toMatchObject({
      kind: 'stale',
      reasons: ['The net amount changed after the proof was made.'],
    });
  });
});

describe('the institution’s policy in this browser', () => {
  const owner = key();
  const policyProgram = key();
  const secret = generatePolicySecret();
  const draft: PolicyDraft = {
    ...newDraft(),
    maxPerTx: '500000000',
    maxDaily: '1000000000',
    dailyCeiling: '1000000000',
    tokenWhitelist: [mint.toBase58()],
    allowedCategories: ['research', 'data'],
  };
  const inst = institutionAddress(policyProgram, owner);
  const policy = policyAddress(policyProgram, inst, hexToBytes(draft.policyId));
  const snapshot = computePolicyCommitment(
    draftDocument(draft, inst.toBase58())!,
    derivePolicySalts(secret, hexToBytes(draft.policyId)),
  );
  const fundedJob = job({ policy, policyCommitment: Array.from(snapshot), policyDailyCeiling: new BN(1_000_000_000) });
  const material = (fields: { secret?: Uint8Array | null; drafts?: PolicyDraft[]; job?: JobAccount }) =>
    policyMaterialFor({
      owner,
      policyProgram,
      job: fields.job ?? fundedJob,
      secret: fields.secret === undefined ? secret : fields.secret,
      drafts: fields.drafts ?? [draft],
    });

  it('finds the job’s policy and its categories', () => {
    const found = material({});
    expect(found.ok && found.material.categories).toEqual(['research', 'data']);
    expect(found.ok && found.material.document.policyId).toBe(draft.policyId);
  });

  it('explains why no proof can be made here', () => {
    expect(material({ secret: null })).toMatchObject({ ok: false, reason: expect.stringMatching(/no policy secret/) });
    expect(material({ drafts: [] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining(policy.toBase58()),
    });
    // Politika job açıldıktan sonra güncellendi: tavan aynı, kural farklı.
    expect(material({ drafts: [{ ...draft, maxPerTx: '400000000' }] })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not the version the job was opened under/),
    });
    expect(material({ secret: generatePolicySecret() })).toMatchObject({ ok: false });
  });
});

describe('prover and verifier', () => {
  it('pins the circuit key the verifier checks', () => {
    const vk = readFileSync(new URL('../../../programs/square-verifier/src/release_vk.rs', import.meta.url), 'utf8');
    expect(RELEASE_ARTIFACT_VERSION).toMatch(/^[0-9a-f]{64}$/);
    expect(vk).toContain(`sha256 ${RELEASE_ARTIFACT_VERSION}`);
  });

  it('explains the prover’s answers', () => {
    const url = 'https://prover.example.org';
    expect(proverErrorMessage(new Error('prover: unauthorized: unknown API key'), url)).toBe(
      'The prover refused the API key.',
    );
    expect(proverErrorMessage(new Error('prover: conflict: artifact mismatch'), url)).toMatch(/another circuit key/);
    expect(proverErrorMessage(new Error('prover: prover_unavailable: queue full'), url)).toMatch(/busy/);
    expect(proverErrorMessage(new Error('prover: invalid_input: max_daily out of range'), url)).toBe(
      'The prover rejected the witness: max_daily out of range',
    );
    expect(proverErrorMessage(new TypeError('Failed to fetch'), url)).toBe(
      'The prover at prover.example.org could not be reached.',
    );
  });

  it('explains the verifier’s refusals', () => {
    const failure = (code: number) => new Error(`Simulation failed: custom program error: 0x${code.toString(16)}`);
    expect(verifierErrorMessage(failure(6005))).toMatch(/StaleProof, 6005\)\. The proof is older than 10 minutes/);
    expect(verifierErrorMessage(failure(6000))).toMatch(/InvalidProof, 6000\)\. The proof does not match/);
    // Kabul öncesi ön-ispat (ADR 0028): işin kendi koşulları politikayı çiğniyor.
    expect(verifierErrorMessage(failure(6012))).toMatch(
      /PreflightRefused, 6012\)\. The job's own terms break the policy/,
    );
    expect(verifierErrorMessage(new Error('User rejected the request.'))).toBeNull();
  });
});
