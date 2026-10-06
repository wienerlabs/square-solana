// Finalize, ödeme ve itibar (FE-10, akışın 6. ve 8. adımları). Challenge penceresi kapanınca finalize'ı herkes
// tetikleyebilir; keeper ücreti tetikleyene gider. Escrow politikalı işte bağlı ispata göre öder ya da kuruma
// iade eder, politikasız işte payee'ye öder; ödemede payee'nin screening'i temiz ve taze olmalıdır. Her
// settlement bir validation kaydı ve agent'ın itibarını yazar. Sonuç job'un event'lerinden,
// `ValidationRecord`'dan ve `AgentReputation`'dan okunur.
import { PublicKey } from '@solana/web3.js';
import { releaseNetAmount } from '@squaresdk/solana-policy';
import { SQUARE_IDLS, type JobAccount } from '@squaresdk/solana-sdk';
import type { KeeperAction, ValidationOutcome } from '@squaresdk/solana-types';
import type { TimelineEntry } from './job-detail';
import { screeningState, type EscrowSetup, type ScreeningState } from './job-wizard';
import { programErrorMessage } from './program-error';
import type { ReleaseOutlook } from './release-proof';

const big = (value: { toString(): string }) => BigInt(value.toString());
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Finalize'ı tetikleyenin payı: `amount × keeper_fee_bps / 10 000` (kalanı payee'nin neti). */
export const keeperFeeOf = (amount: bigint, keeperFeeBps: number): bigint =>
  amount - releaseNetAmount(amount, keeperFeeBps);

export type FinalizeReadiness =
  { ready: true; outcome: 'pays' | 'refunds'; net: bigint; keeperFee: bigint } | { ready: false; reason: string };

/** Payee'nin screening kaydının okunuşu (`readScreening`). */
export type PayeeScreening =
  { state: 'loading' } | { state: 'ready'; value: ScreeningState } | { state: 'error'; message: string };

/** Kayıt okunduğundan beri süresi dolmuş olabilir: durum zincir saatine göre yeniden değerlendirilir. */
function screeningAt(screening: ScreeningState, now: number): ScreeningState {
  if (screening.state === 'missing') return screening;
  const { expiresAt, screenedAt } = screening;
  return screeningState({ flagged: screening.state === 'flagged', expiresAt, screenedAt }, now);
}

/**
 * Ödeme dalında payee'nin screening'i (`require_payee_ready`): kayıt temiz ve taze değilse escrow ödemez,
 * iade de etmez, bekler. Temizse null.
 */
function screeningWait(screening: PayeeScreening, now: number): string | null {
  if (screening.state === 'loading') return "Reading the payee's sanctions screening…";
  if (screening.state === 'error') return `The payee's sanctions screening could not be read: ${screening.message}`;
  const current = screeningAt(screening.value, now);
  switch (current.state) {
    case 'clear':
      return null;
    case 'missing':
      return 'The payee has no sanctions screening on chain, so the escrow would wait (ScreeningRequired).';
    case 'flagged':
      return 'The payee is flagged by sanctions screening, so the escrow would wait (ScreeningFlagged).';
    case 'expired':
      return `The payee's sanctions screening expired at ${iso(current.expiresAt)} (chain time), so the escrow would wait (ScreeningExpired).`;
  }
}

/**
 * Finalize şimdi geçer mi (`finalize_payment`'ın denetimleri, zincir saatine göre)? İş teslim edilmiş ve
 * challenge penceresi kapanmış olmalı; politikalı işte bağlı ispat taze olmalı ve ya uyumlu (ödeme) ya da
 * kesin retle (iade) olmalı. Ödemede payee'nin screening'i temiz ve taze olmalı; kesin retle iadede aranmaz.
 * `release` politikasız işte null'dır.
 */
export function finalizeReadiness(params: {
  job: JobAccount;
  chainNow: number;
  keeperFeeBps: number;
  release: ReleaseOutlook | null;
  payeeScreening: PayeeScreening;
}): FinalizeReadiness {
  const { job, chainNow, keeperFeeBps, release, payeeScreening } = params;
  if (!('delivered' in job.status)) return { ready: false, reason: 'Only a delivered job can be finalized.' };
  const challengeEnd = job.challengeEnd.toNumber();
  if (chainNow < challengeEnd) {
    return {
      ready: false,
      reason: `The challenge window is open until ${iso(challengeEnd)} (chain time); finalize opens then.`,
    };
  }
  const amount = big(job.amount);
  const fees = { net: releaseNetAmount(amount, keeperFeeBps), keeperFee: keeperFeeOf(amount, keeperFeeBps) };
  const pays = (): FinalizeReadiness => {
    const wait = screeningWait(payeeScreening, chainNow);
    return wait ? { ready: false, reason: wait } : { ready: true, outcome: 'pays', ...fees };
  };
  if (!job.policy) return pays();
  if (!release) return { ready: false, reason: 'Reading the compliance proof…' };
  switch (release.kind) {
    case 'pays':
      return pays();
    case 'refunds':
      return { ready: true, outcome: 'refunds', ...fees };
    case 'noProof':
      return { ready: false, reason: 'No compliance proof is bound yet, so the escrow would wait (ProofRequired).' };
    case 'waits':
      return {
        ready: false,
        reason: 'The bound proof refuses this release for now, so the escrow would wait (ProofRequired).',
      };
    case 'stale':
      return {
        ready: false,
        reason: `The bound proof is stale, so the escrow would wait (StaleReleaseProof): ${release.reasons.join(' ')}`,
      };
    case 'consumed':
      return { ready: false, reason: 'The release already used the proof.' };
  }
}

/** Finalize'da escrow hata kodunun açıklaması; ne yapılacağıyla birlikte. */
export function finalizeErrorMessage(error: unknown): string | null {
  const message = programErrorMessage(SQUARE_IDLS.escrow, error);
  if (!message) return null;
  if (/ProofRequired/.test(message)) return `${message}. The institution has to bind a compliance proof first.`;
  if (/StaleReleaseProof/.test(message)) {
    return `${message}. The bound proof no longer matches the release; the institution has to bind a new one.`;
  }
  if (/ChallengePeriodNotExpired/.test(message)) return `${message}. Wait for the challenge window to close.`;
  if (/ScreeningRequired|ScreeningExpired|ScreeningFlagged/.test(message)) {
    return `${message}. The payee needs a clear, unexpired sanctions screening at release; finalize can be retried once it is renewed.`;
  }
  return message;
}

/** Settlement'ın job'un event'lerindeki izi. */
export interface SettlementEvents {
  /** `Finalized`: tetikleyen ve aldığı ücret. */
  finalized: { keeper: PublicKey; keeperFee: bigint; signature: string } | null;
  /** `ReleaseVerified`: payee'ye ödenen net. */
  paid: { payee: PublicKey; net: bigint } | null;
  /** `ReleaseRefused`: kuruma iade edilen ve ret kodu. */
  refunded: { amount: bigint; refusalCode: number } | null;
}

export function settlementEvents(entries: readonly TimelineEntry[]): SettlementEvents {
  const found: SettlementEvents = { finalized: null, paid: null, refunded: null };
  for (const { event, signature } of entries) {
    const d = event.data;
    if (event.name === 'Finalized') {
      found.finalized = { keeper: d.keeper as PublicKey, keeperFee: big(d.keeper_fee as BigIntish), signature };
    }
    if (event.name === 'ReleaseVerified') {
      found.paid = { payee: d.payee as PublicKey, net: big(d.net_amount as BigIntish) };
    }
    if (event.name === 'ReleaseRefused') {
      found.refunded = { amount: big(d.refunded_amount as BigIntish), refusalCode: Number(d.refusal_code) };
    }
  }
  return found;
}

type BigIntish = { toString(): string };

export interface Settlement {
  /** `ValidationRecord`: settlement'ın sonucu; ödenmemiş işte yoktur. */
  validation: { outcome: ValidationOutcome; refusalCode: number; recordedAt: number } | null;
  /** Agent'ın itibarı (`AgentReputation`); ilk settlement'tan önce yoktur. */
  reputation: {
    jobsCompleted: bigint;
    jobsFailed: bigint;
    jobsDisputed: bigint;
    totalEarned: bigint;
    lastJobAt: number;
  } | null;
}

/** Job'un validation kaydı ve agent'ın itibarı. */
export async function readSettlement(setup: EscrowSetup, jobKey: PublicKey, job: JobAccount): Promise<Settlement> {
  const { client } = setup;
  const [validation, reputation] = await Promise.all([
    client.escrow.fetch('validationRecord', client.pda.validationRecord(jobKey)[0]),
    client.escrow.fetch('agentReputation', client.pda.agentReputation(job.agentRecord)[0]),
  ]);
  return {
    validation: validation && {
      outcome: Object.keys(validation.outcome)[0] as ValidationOutcome,
      refusalCode: validation.refusalCode,
      recordedAt: validation.recordedAt.toNumber(),
    },
    reputation: reputation && {
      jobsCompleted: big(reputation.jobsCompleted),
      jobsFailed: big(reputation.jobsFailed),
      jobsDisputed: big(reputation.jobsDisputed),
      totalEarned: big(reputation.totalEarned),
      lastJobAt: reputation.lastJobAt.toNumber(),
    },
  };
}

export const VALIDATION_TEXT: Readonly<Record<ValidationOutcome, string>> = {
  verified: 'Verified: a compliant proof released the payment',
  refused: "Refused: the institution's policy refused the release and the escrow was refunded",
  noGate: 'No gate: the job had no policy and the payee was paid',
  noPayout: 'No payout: a dispute decided for the institution',
};

/** Keeper'ın bekleme ya da başarısızlık sebebi (`KeeperReason`). */
export const KEEPER_REASON_TEXT: Readonly<Record<NonNullable<KeeperAction['reason']>, string>> = {
  challengeOpen: 'the challenge window was still open',
  proofRequired: 'no compliance proof was bound',
  staleProof: 'the bound proof was stale',
  screeningPending: "the payee's screening was not clear yet",
  unprofitable: 'the keeper fee did not cover the transaction cost',
  rpcError: 'the RPC failed',
  programError: 'the program refused the transaction',
};
