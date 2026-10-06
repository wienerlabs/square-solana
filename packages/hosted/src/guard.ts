// Delegasyonun politika kapısı: kurumun yerel politika belgesinin kuralları, tx üretilmeden önce. Kurallar release
// devresinin yedi kuralıdır (release-circuit.md §4) ve aynı ret bitleriyle raporlanır (`REFUSAL`); değerler
// devrenin gördüğü biçimde `normalizePolicy` ile indirgenir (mint ve payee Poseidon alan elemanı, kategori 32 bayt).
// Farklar: tutar job'un brüt tutarıdır (release'teki net, keeper ücreti kadar küçüktür; brüt ile denetlemek daha
// sıkıdır) ve günlük sayaç kurumun bu agent'la bugün açtığı delegasyonların toplamıdır (defter). Hosted agent'a
// özgü ek kural: hedef agent yapılandırmadaki izinli agent'lardan biri olmalı.
import type { PublicKey } from '@solana/web3.js';
import {
  REFUSAL,
  SECONDS_PER_DAY,
  addressField,
  categoryField,
  normalizePolicy,
  refusalRules,
  type NormalizedPolicy,
  type RefusalRule,
} from '@squaresdk/solana-policy';
import type { PolicyDocument } from '@squaresdk/solana-types';

export interface DelegationFacts {
  /** Job'un brüt tutarı (settlement mint atomik birimi). */
  amount: bigint;
  /** Settlement mint. */
  mint: PublicKey;
  /** Ödemeyi alacak cüzdan: hedef agent'ın AgentRecord cüzdanı. */
  payee: PublicKey;
  category: string;
  /** Kurumun bu UTC günü delegasyonlarla bağladığı toplam (bu istek hariç). */
  spentToday: bigint;
  /** Unix saniyesi. */
  now: number;
}

export interface GuardDecision {
  /** 0: izinli; değilse çiğnenen kuralların bitleri (`REFUSAL`). */
  refusalCode: number;
  rules: RefusalRule[];
}

/** Unix saniyesinin UTC haftanın günü, Pazartesi = 0 (1970-01-01 Perşembe). */
export const weekdayUtc = (unix: number): number => (Math.floor(unix / SECONDS_PER_DAY) + 3) % 7;

/** Pencere içinde mi (iki uç saat dahil; pencere kapalıysa her an). */
export function insideTimeWindow(policy: NormalizedPolicy, unix: number): boolean {
  if (policy.timeActive === 0) return true;
  const hour = Math.floor((unix % SECONDS_PER_DAY) / 3_600);
  const dayAllowed = (policy.timeDaysBitmask & (1 << weekdayUtc(unix))) !== 0;
  return dayAllowed && hour >= policy.timeStartHourUtc && hour <= policy.timeEndHourUtc;
}

/** Politikanın yedi kuralını delegasyonun değerlerine uygular. */
export function evaluateDelegation(policy: PolicyDocument, facts: DelegationFacts): GuardDecision {
  const n = normalizePolicy(policy);
  const after = facts.spentToday + facts.amount;
  const mint = addressField(facts.mint);
  const payee = addressField(facts.payee);
  let code = 0;
  if (facts.amount > n.maxPerTx) code |= REFUSAL.perTx;
  if (after > n.maxDaily) code |= REFUSAL.dailyPrivate;
  if (!n.tokenWhitelist.includes(mint)) code |= REFUSAL.mintNotAllowed;
  if (n.blockedAddresses.includes(payee)) code |= REFUSAL.payeeBlocked;
  if (!n.allowedCategories.includes(categoryField(facts.category))) code |= REFUSAL.categoryNotAllowed;
  if (!insideTimeWindow(n, facts.now)) code |= REFUSAL.outsideTimeWindow;
  if (after > n.dailyCeiling) code |= REFUSAL.dailyCeiling;
  return { refusalCode: code, rules: refusalRules(code) };
}
