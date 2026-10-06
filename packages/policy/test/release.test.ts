// Release kuralları (ADR 0012, ADR 0013): ret kodunun kuralları, kesin ret, UTC günü, günlük sayaç,
// net tutar ve tazelik. Zincirdeki kurallarla uyum ortak vektörlerde (release-vectors.test.ts).
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  checkFresh,
  dailySpentAt,
  dayStart,
  isFinalRefusal,
  REFUSAL,
  refusalRules,
  releaseNetAmount,
} from '../src/release.js';

const NOW = 1_790_000_000;
const DAY = 1_789_948_800;

describe('ret kodu', () => {
  it('çiğnenen kuralları bit sırasıyla verir', () => {
    expect(refusalRules(0)).toEqual([]);
    expect(refusalRules(REFUSAL.payeeBlocked | REFUSAL.categoryNotAllowed)).toEqual([
      'payeeBlocked',
      'categoryNotAllowed',
    ]);
    expect(refusalRules(127)).toHaveLength(7);
  });

  it('kalıcı sebepte ve sayaç 0 iken günlük tavanda kesin ret', () => {
    expect(isFinalRefusal(REFUSAL.mintNotAllowed, 40n)).toBe(true);
    expect(isFinalRefusal(REFUSAL.dailyCeiling, 0n)).toBe(true);
    expect(isFinalRefusal(REFUSAL.dailyCeiling, 40n)).toBe(false);
    expect(isFinalRefusal(REFUSAL.categoryNotAllowed | REFUSAL.outsideTimeWindow, 0n)).toBe(false);
  });
});

describe('gün ve sayaç', () => {
  it('UTC günü gece yarısında başlar; 0 ve öncesi 0', () => {
    expect(dayStart(NOW)).toBe(DAY);
    expect(dayStart(DAY)).toBe(DAY);
    expect(dayStart(0)).toBe(0);
    expect(dayStart(-1)).toBe(0);
  });

  it('sayaç aynı günde kalır, yeni günde 0, ileri tarihli durumda bilinemez', () => {
    expect(dailySpentAt(DAY, 40n, NOW)).toBe(40n);
    expect(dailySpentAt(DAY - 86_400, 40n, NOW)).toBe(0n);
    expect(dailySpentAt(DAY + 86_400, 40n, NOW)).toBeNull();
  });

  it('net tutar keeper ücretinden sonra kalan', () => {
    expect(releaseNetAmount(250_000_000n, 50)).toBe(248_750_000n);
    expect(releaseNetAmount(25_510_204n, 200)).toBe(25_000_000n);
  });
});

describe('tazelik', () => {
  const payee = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const proof = { payee, netAmount: 25_000_000n, mint, dailySpentBefore: 40n, proofTimestamp: NOW };
  const target = { payee, netAmount: 25_000_000n, mint };
  const operator = { dayStartUnix: DAY, dailySpent: 40n };

  it('escrow sırasıyla ilk sebebi verir', () => {
    expect(checkFresh(proof, operator, target, NOW + 60)).toBeNull();
    const buyer = Keypair.generate().publicKey;
    expect(checkFresh(proof, operator, { ...target, payee: buyer }, NOW + 86_400)).toBe('payee');
    expect(checkFresh(proof, operator, { ...target, netAmount: 1n }, NOW)).toBe('netAmount');
    expect(checkFresh(proof, operator, { ...target, mint: buyer }, NOW)).toBe('mint');
    expect(checkFresh(proof, operator, target, DAY + 86_400)).toBe('day');
    expect(checkFresh(proof, { ...operator, dailySpent: 90n }, target, NOW)).toBe('dailyCounter');
  });

  it('sayaç hesabı yoksa etkin sayaç 0', () => {
    expect(checkFresh({ ...proof, dailySpentBefore: 0n }, null, target, NOW)).toBeNull();
    expect(checkFresh(proof, null, target, NOW)).toBe('dailyCounter');
  });
});
