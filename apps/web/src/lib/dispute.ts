// Uyuşmazlık (FE-17): itiraz, M-of-N oy sayımı, son tarih ve lapse'ın arayüz kuralları. Kurallar programın
// kendisidir (square_escrow `src/dispute.rs` ve dispute talimatları, ADR 0016); burada yalnızca arayüzün
// hangi düğmeyi ne zaman açacağı ve ne söyleyeceği için yeniden yazılır, son söz yine programındır.
// Süreler zincir saatine göredir (Clock sysvar'ı, `readChainTime`).
import BN from 'bn.js';
import type { PublicKey } from '@solana/web3.js';
import { isFinalRefusal } from '@squaresdk/solana-policy';
import {
  SQUARE_IDLS,
  type DisputeResolution as AnchorResolution,
  type EscrowConfigAccount,
  type JobAccount,
} from '@squaresdk/solana-sdk';
import type { DisputeResolution } from '@squaresdk/solana-types';
import { bytesToHex } from './policy-draft';
import { programErrorMessage } from './program-error';
import type { ProofView } from './release-proof';

export type { DisputeResolution };

const BPS_DENOMINATOR = 10_000n;
const SECONDS_PER_DAY = 86_400;
const big = (value: { toString(): string }) => BigInt(value.toString());

/** Escrow config'inin dispute parametreleri ve aktif arbitrator seti. */
export interface DisputeParams {
  minBondBps: number;
  minBondAbsolute: bigint;
  disputeTimeoutSecs: number;
  proofTimeoutSecs: number;
  /** Karar için gereken onay (M). */
  threshold: number;
  /** `arbitrators[..arbitrator_count]`, sırasıyla (oy bit maskesinin sırası). */
  arbitrators: PublicKey[];
  arbitratorSetVersion: number;
}

export function disputeParamsOf(config: EscrowConfigAccount): DisputeParams {
  return {
    minBondBps: config.params.minBondBps,
    minBondAbsolute: big(config.params.minBondAbsolute),
    disputeTimeoutSecs: config.params.disputeTimeoutSecs.toNumber(),
    proofTimeoutSecs: config.params.proofTimeoutSecs.toNumber(),
    threshold: config.threshold,
    arbitrators: config.arbitrators.slice(0, config.arbitratorCount),
    arbitratorSetVersion: config.arbitratorSetVersion,
  };
}

/**
 * `raise_dispute`'un kabul ettiği en küçük bond: `max(amount × min_bond_bps / 10 000, min_bond_absolute)`,
 * aşağı yuvarlanmış (`dispute::min_bond`); bond sıfır da olamaz, bu yüzden en az 1.
 */
export function minimumBond(amount: bigint, params: Pick<DisputeParams, 'minBondBps' | 'minBondAbsolute'>): bigint {
  const relative = (amount * BigInt(params.minBondBps)) / BPS_DENOMINATOR;
  const floor = relative > params.minBondAbsolute ? relative : params.minBondAbsolute;
  return floor > 0n ? floor : 1n;
}

// ---------------------------------------------------------------- karar

/**
 * Zincirdeki karar değerinin API / tip biçimi (`{ kind }`). Anchor'ın programı enum'u camelCase anahtarla
 * (`{ favorAgent: {} }`), ham IDL'le çalışan event çözücüsü IDL adıyla (`{ FavorAgent: {} }`,
 * `agent_amount`) verir; ikisi de kabul edilir.
 */
export function resolutionOf(value: unknown): DisputeResolution {
  const [variant, inner] = Object.entries((value ?? {}) as Record<string, unknown>)[0] ?? [];
  const kind = variant ? variant.charAt(0).toLowerCase() + variant.slice(1) : '';
  switch (kind) {
    case 'pending':
    case 'favorAgent':
    case 'favorInstitution':
      return { kind };
    case 'split': {
      const fields = (inner ?? {}) as { agentAmount?: unknown; agent_amount?: unknown };
      const amount = fields.agentAmount ?? fields.agent_amount;
      return { kind: 'split', agentAmount: big(amount as { toString(): string }).toString() };
    }
    default:
      throw new Error(`Unknown dispute resolution: ${JSON.stringify(value)}`);
  }
}

/** SDK akışının (`flow.resolveDispute`) beklediği Anchor değeri. */
export function toAnchorResolution(resolution: DisputeResolution): AnchorResolution {
  switch (resolution.kind) {
    case 'pending':
      return { pending: {} };
    case 'favorAgent':
      return { favorAgent: {} };
    case 'favorInstitution':
      return { favorInstitution: {} };
    case 'split':
      return { split: { agentAmount: new BN(resolution.agentAmount) } };
  }
}

export const sameResolution = (a: DisputeResolution, b: DisputeResolution) =>
  a.kind === b.kind && (a.kind !== 'split' || (b.kind === 'split' && a.agentAmount === b.agentAmount));

export const RESOLUTION_LABEL: Readonly<Record<DisputeResolution['kind'], string>> = {
  pending: 'No decision yet',
  favorAgent: 'In favor of the agent',
  favorInstitution: 'In favor of the institution',
  split: 'Split',
};

export function describeResolution(resolution: DisputeResolution, formatAmount: (base: bigint) => string): string {
  return resolution.kind === 'split'
    ? `Split: ${formatAmount(BigInt(resolution.agentAmount))} to the agent, the rest back to the institution`
    : RESOLUTION_LABEL[resolution.kind];
}

/** Kararın ödenişi (`dispute::agent_side` ve `execute_resolution`): escrow ve bond nereye gider. */
export interface ResolutionSettlement {
  agentSide: bigint;
  institutionRefund: bigint;
  bondToAgentSide: bigint;
  bondReturned: bigint;
}

export function settlementOf(resolution: DisputeResolution, amount: bigint, bond: bigint): ResolutionSettlement {
  switch (resolution.kind) {
    case 'pending':
      throw new Error('The dispute has no decision yet.');
    case 'favorAgent':
      return { agentSide: amount, institutionRefund: 0n, bondToAgentSide: bond, bondReturned: 0n };
    case 'favorInstitution':
      return { agentSide: 0n, institutionRefund: amount, bondToAgentSide: 0n, bondReturned: bond };
    case 'split': {
      const agentSide = BigInt(resolution.agentAmount);
      if (agentSide > amount) throw new Error('The split exceeds the escrowed amount.');
      return { agentSide, institutionRefund: amount - agentSide, bondToAgentSide: 0n, bondReturned: bond };
    }
  }
}

// ---------------------------------------------------------------- dispute durumu

/** Job'daki satır içi dispute kaydı (`Job.dispute`), arayüz biçiminde. `raisedAt == 0`: dispute yok. */
export interface DisputeFacts {
  challenger: PublicKey;
  bond: bigint;
  reasonHash: string;
  raisedAt: number;
  deadline: number;
  decidedAt: number;
  closedAt: number;
  lapsed: boolean;
  approvalMask: number;
  approvalCount: number;
  arbitratorSetVersion: number;
  resolution: DisputeResolution;
}

export function disputeFacts(job: Pick<JobAccount, 'dispute'>): DisputeFacts {
  const d = job.dispute;
  return {
    challenger: d.challenger,
    bond: big(d.bond),
    reasonHash: bytesToHex(Uint8Array.from(d.reasonHash)),
    raisedAt: d.raisedAt.toNumber(),
    deadline: d.deadline.toNumber(),
    decidedAt: d.decidedAt.toNumber(),
    closedAt: d.closedAt.toNumber(),
    lapsed: d.lapsed,
    approvalMask: d.approvalMask,
    approvalCount: d.approvalCount,
    arbitratorSetVersion: d.arbitratorSetVersion,
    resolution: resolutionOf(d.resolution),
  };
}

export type DisputePhase =
  | { phase: 'none' }
  /** Oy açık; zincir saati bilinmiyorsa `remaining` null. */
  | { phase: 'open'; remaining: number | null; deadline: number }
  /** Son tarih geçti, karar yok: herkes `lapse_dispute` çağırabilir. */
  | { phase: 'expired'; deadline: number }
  /** M oy toplandı (`Resolved`): herkes `execute_resolution` çağırabilir. */
  | { phase: 'decided'; decidedAt: number }
  /** Karar çıkmadan düştü; bond kuruma döndü, iş `Delivered`'a döndü. */
  | { phase: 'lapsed'; closedAt: number }
  /** Karar ödendi. */
  | { phase: 'closed'; closedAt: number };

export function disputePhase(facts: DisputeFacts, status: string, chainNow: number | null): DisputePhase {
  if (facts.raisedAt === 0) return { phase: 'none' };
  if (status === 'disputed') {
    if (chainNow !== null && chainNow >= facts.deadline) return { phase: 'expired', deadline: facts.deadline };
    return { phase: 'open', remaining: chainNow === null ? null : facts.deadline - chainNow, deadline: facts.deadline };
  }
  if (status === 'resolved') return { phase: 'decided', decidedAt: facts.decidedAt };
  if (facts.lapsed) return { phase: 'lapsed', closedAt: facts.closedAt };
  return { phase: 'closed', closedAt: facts.closedAt };
}

/**
 * Güncel sayım (ADR 0016 madde 2): dispute'un set sürümü config'tekinden eskiyse bir sonraki oy sayımı
 * sıfırlar; o zamana kadar saklı onaylar ve bekleyen karar artık sayılmaz.
 */
export interface VoteTally {
  approvals: number;
  threshold: number;
  /** Sayım eski setle yapılmış; bir sonraki oy baştan başlatır. */
  stale: boolean;
  /** İlk oyun belirlediği karar; yoksa `pending`. */
  decision: DisputeResolution;
  /** Aktif setin her üyesi için güncel sayımda oy verip vermediği, set sırasıyla. */
  voted: boolean[];
}

export function voteTally(facts: DisputeFacts, params: DisputeParams): VoteTally {
  const stale = facts.arbitratorSetVersion !== params.arbitratorSetVersion;
  return {
    approvals: stale ? 0 : facts.approvalCount,
    threshold: params.threshold,
    stale,
    decision: stale ? { kind: 'pending' } : facts.resolution,
    voted: params.arbitrators.map((_, index) => !stale && (facts.approvalMask & (1 << index)) !== 0),
  };
}

/** Oyun seçenekleri: karar bekliyorsa hepsi, ilk oy belirlediyse yalnızca o karar (`ResolutionMismatch`). */
export type VoteChoices = { kind: 'any' } | { kind: 'fixed'; resolution: DisputeResolution };

export function voteChoices(tally: VoteTally): VoteChoices {
  return tally.decision.kind === 'pending' ? { kind: 'any' } : { kind: 'fixed', resolution: tally.decision };
}

/** Bu cüzdanın şimdi oy verememesinin sebebi; verebiliyorsa null (`resolve_dispute`'un ön koşulları). */
export function voteBlock(params: {
  status: string;
  facts: DisputeFacts;
  disputeParams: DisputeParams;
  arbitrator: PublicKey;
  chainNow: number | null;
}): string | null {
  const { status, facts, disputeParams, arbitrator, chainNow } = params;
  const index = disputeParams.arbitrators.findIndex((key) => key.equals(arbitrator));
  if (index < 0) return 'This wallet is not in the escrow’s active arbitrator set.';
  if (status !== 'disputed') return 'The dispute is no longer open for votes.';
  if (chainNow === null) return 'Reading the chain clock…';
  if (chainNow >= facts.deadline) return 'Voting closed: the dispute deadline has passed.';
  if (voteTally(facts, disputeParams).voted[index]) return 'You have already voted in the current count.';
  return null;
}

export type RaiseState = { ok: true; remaining: number; challengeEnd: number } | { ok: false; reason: string };

/** Kurumun `raise_dispute`'u: teslim edilmiş iş, işte ilk dispute, challenge penceresi açık. */
export function raiseState(params: {
  status: string;
  challengeEnd: number;
  facts: DisputeFacts;
  chainNow: number | null;
}): RaiseState {
  const { status, challengeEnd, facts, chainNow } = params;
  if (facts.raisedAt !== 0)
    return {
      ok: false,
      reason: facts.lapsed
        ? 'This job already had a dispute, which lapsed; an institution disputes a job only once.'
        : 'A dispute is already open or decided on this job.',
    };
  if (status !== 'delivered') return { ok: false, reason: 'Only delivered work can be disputed.' };
  if (chainNow === null) return { ok: false, reason: 'Reading the chain clock…' };
  if (chainNow >= challengeEnd)
    return { ok: false, reason: 'The challenge window has closed; the delivery can no longer be disputed.' };
  return { ok: true, remaining: challengeEnd - chainNow, challengeEnd };
}

/** İspatın bugün (zincir saatinin UTC gününde) işi kapatabilmesi: `escalate_missing_proof`'un `proof_can_settle`'ı. */
export function proofSettlesToday(
  proof: Pick<ProofView, 'consumed' | 'proofTimestamp' | 'compliant' | 'refusalCode' | 'dailySpentBefore'> | null,
  chainNow: number,
): boolean {
  if (!proof || proof.consumed) return false;
  const day = (unix: number) => Math.floor(unix / SECONDS_PER_DAY);
  if (day(proof.proofTimestamp) !== day(chainNow)) return false;
  return proof.compliant || isFinalRefusal(proof.refusalCode, proof.dailySpentBefore);
}

export type EscalationState =
  | { state: 'notApplicable' }
  | { state: 'waiting'; readyAt: number; remaining: number }
  | { state: 'proofSettles' }
  | { state: 'ready' }
  | { state: 'blocked'; reason: string };

/**
 * Agent'ın ispatsız bekleme başvurusu (ADR 0016 madde 6): policy'li ve `Delivered` iş; bekleme
 * `challenge_end`'den (önceki dispute lapse olduysa onun kapanışından) `proof_timeout_secs` sürer; bugün
 * işi kapatabilecek bir ispat bağlıysa başvuru gereksizdir.
 */
export function escalationState(params: {
  status: string;
  hasPolicy: boolean;
  challengeEnd: number;
  facts: DisputeFacts;
  proofTimeoutSecs: number;
  chainNow: number | null;
  proofSettles: boolean;
}): EscalationState {
  const { status, hasPolicy, challengeEnd, facts, proofTimeoutSecs, chainNow } = params;
  if (!hasPolicy || status !== 'delivered') return { state: 'notApplicable' };
  if (facts.raisedAt !== 0 && !facts.lapsed) return { state: 'notApplicable' };
  const since = facts.raisedAt === 0 ? challengeEnd : Math.max(facts.closedAt, challengeEnd);
  const readyAt = since + proofTimeoutSecs;
  if (chainNow === null) return { state: 'blocked', reason: 'Reading the chain clock…' };
  if (chainNow < readyAt) return { state: 'waiting', readyAt, remaining: readyAt - chainNow };
  if (params.proofSettles) return { state: 'proofSettles' };
  return { state: 'ready' };
}

/** Lapse sonrası bilgi: iş `Delivered`'a döndü, bond kuruma iade edildi (bond'suz başvuruda iade yok). */
export function lapseNotice(facts: DisputeFacts, formatAmount: (base: bigint) => string): string {
  const refund =
    facts.bond > 0n
      ? `the bond of ${formatAmount(facts.bond)} was refunded to the institution`
      : 'there was no bond to refund (the agent’s escalation)';
  return `The dispute lapsed without a decision: ${refund}. The job went back to Delivered and settles through finalize_payment.`;
}

// ---------------------------------------------------------------- hatalar

/** Dispute talimatlarının hatalarında ne olduğu ve ne yapılacağı (escrow IDL adlarıyla). */
export const DISPUTE_ERROR_HINTS: Readonly<Record<string, string>> = {
  InsufficientBond:
    'The bond must be at least max(amount × min_bond_bps / 10 000, min_bond_absolute) from the escrow config, and above zero.',
  DisputeWindowClosed:
    'A dispute can only be raised before the challenge window closes, and votes are only accepted before the dispute deadline.',
  DisputeAlreadyRaised:
    'An institution disputes a job only once, even if the earlier dispute lapsed; the agent can escalate again after a lapse.',
  DisputeAlreadyActive: 'A dispute is already open or decided on this job.',
  NoActiveDispute: 'The job has no open dispute any more; it may have been decided or lapsed already.',
  NotArbitrator: 'The wallet is not in the escrow’s active arbitrator set.',
  AlreadyVoted: 'This wallet has already voted in the current count.',
  ResolutionMismatch: 'The first vote set the decision; later votes must match it exactly.',
  ResolutionNotDecided: 'The dispute has not reached the arbitrator threshold yet.',
  InvalidSplitAmount: 'The agent’s share of a split cannot exceed the escrowed amount.',
  DisputeNotExpired: 'The dispute can be lapsed only at or after its deadline.',
  ProofTimeoutNotReached:
    'The agent can escalate only after the proof waiting period: challenge end (or the earlier dispute’s close) plus proof_timeout_secs.',
  InvalidDisputeTimeout:
    'The escrow’s dispute timing is misconfigured (dispute_timeout_secs must be positive, proof_timeout_secs not negative); the escrow admin has to fix it.',
  ProofRequired:
    'The agent’s side passes the compliance proof gate: the payment waits until the institution binds a fresh proof after the decision.',
  StaleReleaseProof:
    'The bound proof no longer matches today’s payment (payee, amount, day or counter); the institution has to bind a new one.',
  ScreeningRequired: 'The payee needs a clear, unexpired sanctions screening before anything is paid to it.',
  ScreeningExpired: 'The payee needs a clear, unexpired sanctions screening before anything is paid to it.',
  ScreeningFlagged: 'The payee is flagged by sanctions screening; nothing is paid to it.',
  InvalidStatus:
    'The job is not in the status this step needs. For an escalation: if a compliant proof or a final refusal for today is bound, finalize the payment instead.',
};

export const disputeHint = (name: string): string | null => DISPUTE_ERROR_HINTS[name] ?? null;

/** Gönderim ya da simülasyon hatasındaki escrow hata kodunun açıklaması ve ne yapılacağı; kod yoksa null. */
export function disputeErrorMessage(error: unknown): string | null {
  const message = programErrorMessage(SQUARE_IDLS.escrow, error);
  if (!message) return null;
  const name = /\((\w+), \d+\)$/.exec(message)?.[1];
  const hint = name ? disputeHint(name) : null;
  return hint ? `${message}. ${hint}` : message;
}
