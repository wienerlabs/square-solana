// Uyum ispatı ve release durumu (FE-09, akışın 7. adımı). Kabulden önce (ADR 0028) kurum işin kendi koşullarıyla
// ön-ispatı bağlar (`PreflightProof`); policy'li işi agent ancak bundan sonra kabul eder. Politikaya bağlı işte escrow, kurumun bağladığı
// release ispatı (`ReleaseProof`) tazeyse ve uyumluysa öder, kalıcı bir sebeple reddediyorsa kuruma iade
// eder, değilse bekler (`ProofRequired`). Kurallar (ADR 0012 / 0013) `@squaresdk/solana-policy`'dendir,
// zincirdekilerle ortak vektörlerle denetlenir; bu modül arayüzün metinlerini ve kararını kurar. İspatı
// prover servisi üretir (snarkjs yalnızca `apps/prover`'da çalışır).
import type { PublicKey } from '@solana/web3.js';
import {
  checkFresh,
  CLOCK_TOLERANCE_SECS,
  computePolicyCommitment,
  derivePolicySalts,
  isFinalRefusal,
  refusalRules,
  releaseNetAmount,
  type PolicySalts,
  type RefusalRule,
  type Staleness,
} from '@squaresdk/solana-policy';
import { SQUARE_IDLS, type ClaimListingAccount, type JobAccount } from '@squaresdk/solana-sdk';
import type { PolicyDocument } from '@squaresdk/solana-types';
import manifest from '../../../../circuits/payment-compliance/artifacts/manifest.json';
import { payeeOf } from './claim-market';
import { institutionAddress, policyAddress } from './idl-pda';
import type { EscrowSetup } from './job-wizard';
import { draftDocument, hexToBytes, type PolicyDraft } from './policy-draft';
import { programErrorMessage } from './program-error';

/**
 * Prover'ın kullanması gereken artefakt sürümü: zkey'in SHA-256'sı (devrenin manifest'i, BC-20). Verifier
 * aynı zkey'in doğrulama anahtarını taşır (`release_vk.rs`); başka anahtarla yapılmış ispat zincirde düşer.
 */
export const RELEASE_ARTIFACT_VERSION: string = manifest.zkey.sha256;

/** Ret kodunun kurallarının açıklaması; kurallar ve bitleri `@squaresdk/solana-policy`'nin (`REFUSAL`). */
const REFUSAL_TEXT: Readonly<Record<RefusalRule, string>> = {
  perTx: 'The amount is above the per-transaction limit',
  dailyPrivate: 'The amount would exceed the private daily limit',
  mintNotAllowed: 'The settlement mint is not on the token whitelist',
  payeeBlocked: 'The payee is on the blocked list',
  categoryNotAllowed: 'The payment category is not allowed',
  outsideTimeWindow: 'The release is outside the allowed time window',
  dailyCeiling: 'The amount would exceed the public daily ceiling',
};

export const refusalReasons = (code: number): string[] => refusalRules(code).map((rule) => REFUSAL_TEXT[rule]);

const STALE_TEXT: Readonly<Record<Staleness, string>> = {
  payee: 'The payee changed after the proof was made.',
  netAmount: 'The net amount changed after the proof was made.',
  mint: 'The proof is for another mint.',
  day: 'A new UTC day started; the proof only pays out on the day it was made.',
  dailyCounter: "Another release moved the institution's daily counter after the proof was made.",
};

const big = (value: { toString(): string }) => BigInt(value.toString());

export interface ProofView {
  payee: PublicKey;
  netAmount: bigint;
  mint: PublicKey;
  dailySpentBefore: bigint;
  proofTimestamp: number;
  compliant: boolean;
  refusalCode: number;
  consumed: boolean;
}

export interface ReleaseState {
  proof: ProofView | null;
  /** Kurumun günlük sayacı; ilk ispattan önce hesap yoktur. */
  operator: { dailySpent: bigint; dayStartUnix: number } | null;
  keeperFeeBps: number;
  /** Politikanın bağlı olduğu `Institution` PDA'sı ve onun yetkilisi Squads vault'u mu. */
  institution: PublicKey;
  multisigVault: PublicKey | null;
}

/** Kabul öncesi ön-ispat (ADR 0028): bağlıysa ret kodu (yalnızca zaman penceresi ve kategori bitleri) ve anı. */
export interface PreflightView {
  /** Bağlamadaki agent cüzdanı; escrow `accept_job` işin güncel cüzdanıyla aynı olmasını ister. */
  payee: PublicKey;
  refusalCode: number;
  proofTimestamp: number;
}

/** Policy'li işin ön-ispatı; bağlanmamışsa null. */
export async function readPreflight(setup: EscrowSetup, jobKey: PublicKey): Promise<PreflightView | null> {
  const proof = await setup.client.verifier.fetch('preflightProof', setup.client.pda.preflightProof(jobKey)[0]);
  return (
    proof && { payee: proof.payee, refusalCode: proof.refusalCode, proofTimestamp: proof.proofTimestamp.toNumber() }
  );
}

/**
 * Ön-ispat işin güncel agent cüzdanı için mi (`accept_job`'ın kuralı, ADR 0028)? Cüzdan bağlamadan sonra
 * `sync_agent_wallet` ile taşındıysa değildir: kurum yeniden bağlar.
 */
export const preflightBoundFor = (view: PreflightView | null, agentWallet: PublicKey): boolean =>
  view !== null && view.payee.equals(agentWallet);

/** Job'un release ispatı, kurumun sayacı ve escrow'un keeper ücreti. Job politikaya bağlı olmalı. */
export async function readReleaseState(setup: EscrowSetup, jobKey: PublicKey, job: JobAccount): Promise<ReleaseState> {
  if (!job.policy) throw new Error('The job is not bound to a policy.');
  const { client } = setup;
  const [policy, config, proof] = await Promise.all([
    client.policy.fetch('policy', job.policy),
    client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]),
    client.verifier.fetch('releaseProof', client.pda.releaseProof(jobKey)[0]),
  ]);
  if (!policy) throw new Error(`The job's policy account was not found: ${job.policy.toBase58()}`);
  if (!config) throw new Error('The escrow config was not found.');
  const [operator, institution] = await Promise.all([
    client.verifier.fetch('operatorState', client.pda.operatorState(policy.institution)[0]),
    client.policy.fetch('institution', policy.institution),
  ]);
  if (!institution) throw new Error(`The institution account was not found: ${policy.institution.toBase58()}`);
  return {
    proof: proof && {
      payee: proof.payee,
      netAmount: big(proof.netAmount),
      mint: proof.mint,
      dailySpentBefore: big(proof.dailySpentBefore),
      proofTimestamp: proof.proofTimestamp.toNumber(),
      compliant: 'compliant' in proof.verdict,
      refusalCode: proof.refusalCode,
      consumed: proof.consumed,
    },
    operator: operator && { dailySpent: big(operator.dailySpent), dayStartUnix: operator.dayStartUnix.toNumber() },
    keeperFeeBps: config.params.keeperFeeBps,
    institution: policy.institution,
    multisigVault: institution.multisigVault,
  };
}

/**
 * İspatın şimdi (zincir saatiyle) yapılacak bir release için bayatlık sebebi; tazeyse null. Kural escrow'un
 * `check_fresh`'idir (`checkFresh`, ADR 0012 §4); release'in payee'si, neti ve mint'i job'dan ve alacaktan.
 */
export function staleReason(
  proof: ProofView,
  facts: {
    job: JobAccount;
    listing: ClaimListingAccount | null;
    keeperFeeBps: number;
    operator: ReleaseState['operator'];
    chainNow: number;
  },
): string | null {
  const payee = payeeOf(facts.job, facts.listing);
  const reason = checkFresh(
    proof,
    facts.operator,
    {
      payee: payee.wallet,
      netAmount: releaseNetAmount(big(facts.job.amount), facts.keeperFeeBps),
      mint: facts.job.mint,
    },
    facts.chainNow,
  );
  if (reason === 'payee' && payee.sold) {
    return 'The receivable was sold after the proof was made, so the payee is now the buyer.';
  }
  return reason && STALE_TEXT[reason];
}

/** Escrow'un şimdi yapılacak bir finalize'da ne yapacağı. */
export type ReleaseOutlook =
  | { kind: 'noProof' }
  | { kind: 'consumed'; proof: ProofView }
  | { kind: 'stale'; proof: ProofView; reasons: string[] }
  | { kind: 'pays'; proof: ProofView }
  | { kind: 'refunds'; proof: ProofView; reasons: string[] }
  | { kind: 'waits'; proof: ProofView; reasons: string[] };

export function releaseOutlook(
  state: ReleaseState,
  job: JobAccount,
  listing: ClaimListingAccount | null,
  chainNow: number,
): ReleaseOutlook {
  const { proof } = state;
  if (!proof) return { kind: 'noProof' };
  if (proof.consumed) return { kind: 'consumed', proof };
  const stale = staleReason(proof, {
    job,
    listing,
    keeperFeeBps: state.keeperFeeBps,
    operator: state.operator,
    chainNow,
  });
  if (stale) return { kind: 'stale', proof, reasons: [stale] };
  if (proof.compliant) return { kind: 'pays', proof };
  const reasons = refusalReasons(proof.refusalCode);
  return isFinalRefusal(proof.refusalCode, proof.dailySpentBefore)
    ? { kind: 'refunds', proof, reasons }
    : { kind: 'waits', proof, reasons };
}

/** square_verifier hata kodunun açıklaması; bağlamada sık görülenler için ne yapılacağı da söylenir. */
export function verifierErrorMessage(error: unknown): string | null {
  const message = programErrorMessage(SQUARE_IDLS.verifier, error);
  if (!message) return null;
  if (/StaleProof/.test(message)) {
    return `${message}. The proof is older than ${CLOCK_TOLERANCE_SECS / 60} minutes of chain time or the daily counter moved; make a new one.`;
  }
  if (/InvalidProof/.test(message)) {
    return `${message}. The proof does not match the job as it is now (payee, amount or counter); make a new one.`;
  }
  if (/PreflightRefused/.test(message)) {
    return `${message}. The job's own terms break the policy (per-transaction limit, token, blocked payee or a daily limit), so no agent can accept it; cancel it.`;
  }
  return message;
}

export interface PolicyMaterial {
  document: PolicyDocument;
  salts: PolicySalts;
  /** Ödeme kategorisi bunlardan biri değilse ispat reddeder (bit 4). */
  categories: readonly string[];
}

/**
 * Job'un politikası bu tarayıcıdaki FE-04 çalışma alanından: sır ve job'un politika adresine düşen taslak.
 * Taslak job açılırken alınan snapshot'la (commitment ve public tavan) aynı olmalı; politika sonradan
 * güncellendiyse eski hâli artık yoktur.
 */
export function policyMaterialFor(params: {
  owner: PublicKey;
  policyProgram: PublicKey;
  job: JobAccount;
  secret: Uint8Array | null;
  drafts: readonly PolicyDraft[];
}): { ok: true; material: PolicyMaterial } | { ok: false; reason: string } {
  const { owner, policyProgram, job, secret, drafts } = params;
  if (!job.policy) return { ok: false, reason: 'The job is not bound to a policy.' };
  if (!secret) {
    return {
      ok: false,
      reason: 'This browser has no policy secret for this wallet. Restore the policy backup on the policy page.',
    };
  }
  const institution = institutionAddress(policyProgram, owner);
  const draft = drafts.find((d) =>
    policyAddress(policyProgram, institution, hexToBytes(d.policyId)).equals(job.policy!),
  );
  if (!draft) {
    return {
      ok: false,
      reason: `This browser does not hold the job's policy (${job.policy.toBase58()}). Restore the backup that has it on the policy page.`,
    };
  }
  const document = draftDocument(draft, institution.toBase58());
  if (!document) return { ok: false, reason: "The job's policy draft in this browser is incomplete." };
  const salts = derivePolicySalts(secret, hexToBytes(draft.policyId));
  const commitment = computePolicyCommitment(document, salts);
  if (
    !commitment.every((byte, i) => byte === job.policyCommitment[i]) ||
    BigInt(document.dailyCeiling) !== big(job.policyDailyCeiling)
  ) {
    return {
      ok: false,
      reason:
        'The policy in this browser is not the version the job was opened under: the policy changed after the job was funded, so no proof can match the job.',
    };
  }
  return { ok: true, material: { document, salts, categories: draft.allowedCategories } };
}

/** Prover'dan gelen hatanın okunur hâli; `createRemoteProver` "prover: <kod>: <mesaj>" fırlatır. */
export function proverErrorMessage(error: unknown, proverUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = /^prover: ([a-z_]+):/.exec(message)?.[1];
  switch (code) {
    case 'unauthorized':
      return 'The prover refused the API key.';
    case 'conflict':
      return `The prover runs another circuit key than the one the verifier checks (${RELEASE_ARTIFACT_VERSION.slice(0, 12)}…).`;
    case 'prover_unavailable':
      return 'The prover is busy right now; try again in a moment.';
    case 'invalid_input':
      return `The prover rejected the witness: ${message.slice(message.indexOf(':', 8) + 2)}`;
    default:
      if (error instanceof TypeError) return `The prover at ${new URL(proverUrl).host} could not be reached.`;
      return message;
  }
}
