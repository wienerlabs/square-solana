// Release ispatının kuralları: ret kodunun bitleri, kesin ret (ADR 0013), günlük sayaç ve tazelik
// (ADR 0012). Zincirdeki kuralların (`square_common::release`, `square_common::time`) TypeScript
// karşılığıdır; ikisinin uyumu ortak vektörlerle denetlenir
// (`crates/square-common/tests/fixtures/release-rule-vectors.json`, `scripts/release-vectors.mjs`).
import type { PublicKey } from '@solana/web3.js';

/** Ret kodunun bitleri, bit sırasıyla (release-circuit.md §3; `square_common::release::refusal`). */
export const REFUSAL = Object.freeze({
  perTx: 1,
  dailyPrivate: 2,
  mintNotAllowed: 4,
  payeeBlocked: 8,
  categoryNotAllowed: 16,
  outsideTimeWindow: 32,
  dailyCeiling: 64,
});

export type RefusalRule = keyof typeof REFUSAL;

/** Release'in kendisinden gelen, zamanla değişmeyen sebepler: tutar, mint ve payee. */
export const PERMANENT_REFUSALS = REFUSAL.perTx | REFUSAL.mintNotAllowed | REFUSAL.payeeBlocked;

/** Günlük tavanlar: sayaç 0 iken kesin, değilse gece yarısı sayaç sıfırlanınca geçebilir. */
export const DAILY_REFUSALS = REFUSAL.dailyPrivate | REFUSAL.dailyCeiling;

/**
 * Kabul öncesi ön-ispatı reddeden bitler (ADR 0028): ön-ispat sayaç 0 ile kurulur, bu yüzden günlük tavan bitleri de
 * kesindir. Zaman penceresi ve kategori geçicidir, ön-ispatı engellemez.
 */
export const PREFLIGHT_BLOCKING = PERMANENT_REFUSALS | DAILY_REFUSALS;

/** Kabul öncesi ön-ispat kabul edilir mi (`preflight_accepts`): ret kodunda kalıcı bit ve günlük tavan biti yok. */
export const preflightAccepts = (refusalCode: number): boolean => (refusalCode & PREFLIGHT_BLOCKING) === 0;

/** Ret kodunun çiğnenen kuralları, bit sırasıyla. */
export function refusalRules(refusalCode: number): RefusalRule[] {
  return (Object.keys(REFUSAL) as RefusalRule[]).filter((rule) => (refusalCode & REFUSAL[rule]) !== 0);
}

/**
 * Ret, escrow'u kuruma iade edecek kesin bir karar mı (`is_final_refusal`)? Kalıcı bir sebep yoksa ret
 * geçicidir ya da kurumun beyanına bağlıdır (kategori); escrow bekler.
 */
export function isFinalRefusal(refusalCode: number, dailySpentBefore: bigint): boolean {
  return (refusalCode & PERMANENT_REFUSALS) !== 0 || (dailySpentBefore === 0n && (refusalCode & DAILY_REFUSALS) !== 0);
}

export const SECONDS_PER_DAY = 86_400;

/** `set_compliance_proof`'ta ispatın anı ile zincirin saati arasındaki en büyük fark (verifier, ADR 0012 §3). */
export const CLOCK_TOLERANCE_SECS = 600;

/** Anın UTC gününün başı (`square_common::time::day_start`); 0 ve öncesi için 0. */
export const dayStart = (unixTimestamp: number): number =>
  unixTimestamp <= 0 ? 0 : unixTimestamp - (unixTimestamp % SECONDS_PER_DAY);

/**
 * `OperatorState`'in `at` anındaki etkin sayacı (`daily_spent_at`): durum aynı UTC gününe aitse sayaç,
 * daha eski bir güne aitse 0; durum daha yeni bir güne aitse `at` için bilinemez (null).
 */
export function dailySpentAt(dayStartUnix: number, dailySpent: bigint, at: number): bigint | null {
  const day = dayStart(at);
  if (dayStartUnix === day) return dailySpent;
  return dayStartUnix < day ? 0n : null;
}

/** Payee'nin release'te alacağı tutar: `amount − amount × keeper_fee_bps / 10 000` (escrow'un finalize'ı). */
export const releaseNetAmount = (amount: bigint, keeperFeeBps: number): bigint =>
  amount - (amount * BigInt(keeperFeeBps)) / 10_000n;

/** Bağlanmış ispatın tazeliği belirleyen alanları (`ReleaseProof`). */
export interface BoundProof {
  payee: PublicKey;
  netAmount: bigint;
  mint: PublicKey;
  dailySpentBefore: bigint;
  proofTimestamp: number;
}

/** Release'in zincirde yapılacağı hâli; escrow kendi hesaplarından türetir (`ReleaseFacts`). */
export interface ReleaseTarget {
  /** Satılmış alacakta alıcı, değilse `Job.agent_wallet`. */
  payee: PublicKey;
  netAmount: bigint;
  mint: PublicKey;
}

/** Kurumun günlük sayacı (`OperatorState`). */
export interface OperatorCounter {
  dayStartUnix: number;
  dailySpent: bigint;
}

/** İspatın neden bayat olduğu (`Staleness`); escrow `StaleReleaseProof`, verifier `StaleProof` döner. */
export type Staleness = 'payee' | 'netAmount' | 'mint' | 'day' | 'dailyCounter';

/**
 * İspat `now` anındaki release için hâlâ geçerli mi (`check_fresh`, ADR 0012 §4)? Tazeyse null, değilse
 * escrow'un sırasıyla ilk sebep. Sayaç hesabı yoksa (ilk ispattan önce) etkin sayaç 0'dır.
 */
export function checkFresh(
  proof: BoundProof,
  operator: OperatorCounter | null,
  target: ReleaseTarget,
  now: number,
): Staleness | null {
  if (!proof.payee.equals(target.payee)) return 'payee';
  if (proof.netAmount !== target.netAmount) return 'netAmount';
  if (!proof.mint.equals(target.mint)) return 'mint';
  if (dayStart(proof.proofTimestamp) !== dayStart(now)) return 'day';
  const counter = operator ? dailySpentAt(operator.dayStartUnix, operator.dailySpent, now) : 0n;
  return counter === proof.dailySpentBefore ? null : 'dailyCounter';
}
