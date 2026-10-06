// Politika kapısı: release devresinin yedi kuralı delegasyonun değerlerine; sınır değerler izinli, bir birim fazlası
// ret; birden çok ihlal bütün bitleriyle.
import { Keypair } from '@solana/web3.js';
import { REFUSAL } from '@squaresdk/solana-policy';
import { describe, expect, it } from 'vitest';
import { evaluateDelegation, insideTimeWindow, weekdayUtc, type DelegationFacts } from '../src/guard.js';
import { normalizePolicy } from '@squaresdk/solana-policy';
import { policyDocument } from './helpers/config.js';

const mint = Keypair.generate().publicKey;
const payee = Keypair.generate().publicKey;
const policy = policyDocument(mint.toBase58());
/** 1970-01-05 Pazartesi 00:00 UTC. */
const MONDAY = 4 * 86_400;
const facts = (overrides: Partial<DelegationFacts> = {}): DelegationFacts => ({
  amount: 1_000_000n,
  mint,
  payee,
  category: 'research',
  spentToday: 0n,
  now: MONDAY + 10 * 3_600,
  ...overrides,
});

describe('evaluateDelegation', () => {
  it('izinli istek', () => {
    expect(evaluateDelegation(policy, facts())).toEqual({ refusalCode: 0, rules: [] });
  });

  it('işlem başı tavan: sınırda izinli, bir birim fazlası ret', () => {
    expect(evaluateDelegation(policy, facts({ amount: 5_000_000n })).refusalCode).toBe(0);
    expect(evaluateDelegation(policy, facts({ amount: 5_000_001n }))).toEqual({
      refusalCode: REFUSAL.perTx,
      rules: ['perTx'],
    });
  });

  it('gizli ve public günlük tavan bugünkü harcamayla birlikte', () => {
    expect(evaluateDelegation(policy, facts({ amount: 3_000_000n, spentToday: 5_000_000n })).refusalCode).toBe(0);
    expect(evaluateDelegation(policy, facts({ amount: 3_000_001n, spentToday: 5_000_000n })).rules).toEqual([
      'dailyPrivate',
    ]);
    const loose = policyDocument(mint.toBase58(), { maxDaily: '20000000' });
    expect(evaluateDelegation(loose, facts({ amount: 2_000_000n, spentToday: 8_000_000n })).refusalCode).toBe(0);
    expect(evaluateDelegation(loose, facts({ amount: 2_000_001n, spentToday: 8_000_000n })).rules).toEqual([
      'dailyCeiling',
    ]);
  });

  it('mint, engelli payee ve kategori', () => {
    expect(evaluateDelegation(policy, facts({ mint: Keypair.generate().publicKey })).rules).toEqual(['mintNotAllowed']);
    const blocked = policyDocument(mint.toBase58(), { blockedPayees: [payee.toBase58()] });
    expect(evaluateDelegation(blocked, facts()).rules).toEqual(['payeeBlocked']);
    expect(evaluateDelegation(policy, facts({ category: 'translation' })).refusalCode).toBe(0);
    expect(evaluateDelegation(policy, facts({ category: 'gambling' })).rules).toEqual(['categoryNotAllowed']);
  });

  it('zaman penceresi: gün ve iki uç saat dahil', () => {
    const windowed = policyDocument(mint.toBase58(), {
      timeWindow: { days: ['monday', 'tuesday'], startHourUtc: 9, endHourUtc: 17 },
    });
    expect(weekdayUtc(MONDAY)).toBe(0);
    expect(weekdayUtc(MONDAY + 6 * 86_400)).toBe(6);
    expect(evaluateDelegation(windowed, facts({ now: MONDAY + 9 * 3_600 })).refusalCode).toBe(0);
    expect(evaluateDelegation(windowed, facts({ now: MONDAY + 18 * 3_600 - 1 })).refusalCode).toBe(0);
    expect(evaluateDelegation(windowed, facts({ now: MONDAY + 18 * 3_600 })).rules).toEqual(['outsideTimeWindow']);
    expect(evaluateDelegation(windowed, facts({ now: MONDAY + 8 * 3_600 + 3_599 })).rules).toEqual([
      'outsideTimeWindow',
    ]);
    expect(evaluateDelegation(windowed, facts({ now: MONDAY + 2 * 86_400 + 10 * 3_600 })).rules).toEqual([
      'outsideTimeWindow',
    ]);
    expect(insideTimeWindow(normalizePolicy(policy), MONDAY + 3 * 3_600)).toBe(true);
  });

  it('birden çok ihlal bütün bitleriyle', () => {
    const decision = evaluateDelegation(
      policy,
      facts({ amount: 50_000_000n, category: 'gambling', mint: Keypair.generate().publicKey }),
    );
    expect(decision.rules).toEqual(['perTx', 'dailyPrivate', 'mintNotAllowed', 'categoryNotAllowed', 'dailyCeiling']);
    expect(decision.refusalCode).toBe(
      REFUSAL.perTx | REFUSAL.dailyPrivate | REFUSAL.mintNotAllowed | REFUSAL.categoryNotAllowed | REFUSAL.dailyCeiling,
    );
  });
});
