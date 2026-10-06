// Karar mantığı: finalize / beklet / kârsız (fixture girdilerle; gerçek finalize BE-36'da).
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  costInMintUnits,
  keeperFee,
  nextAttemptAt,
  precheck,
  profitable,
  type FinalizeFacts,
} from '../src/decide.js';
import { percentile } from '../src/crank.js';

const NOW = 1_790_000_000;
const AGENT = 'Agent11111111111111111111111111111111111111';
const BUYER = 'Buyer11111111111111111111111111111111111111';
const MINT = 'Mint111111111111111111111111111111111111111';
const POLICY = 'Po1icy1111111111111111111111111111111111111';

const facts = (overrides: Partial<FinalizeFacts> = {}): FinalizeFacts => ({
  now: NOW,
  keeperFeeBps: 50,
  job: {
    status: 'delivered',
    challengeEnd: NOW - 1,
    amount: 1_000_000_000n,
    mint: MINT,
    policy: null,
    agentWallet: AGENT,
  },
  listing: null,
  proof: null,
  payeeScreening: { status: 'clear', expiresAt: NOW + 3_600 },
  ...overrides,
});
const withPolicy = (overrides: Partial<FinalizeFacts> = {}) =>
  facts({ job: { ...facts().job, policy: POLICY }, ...overrides });
const compliant = { consumed: false, verdict: 'compliant' as const, payee: AGENT, netAmount: 995_000_000n, mint: MINT };

describe('ön kontrol', () => {
  it('policy’siz, teslim edilmiş ve penceresi bitmiş job finalize edilir; ücret ve net', () => {
    expect(precheck(facts())).toEqual({ kind: 'proceed', payee: AGENT, fee: 5_000_000n, net: 995_000_000n });
    expect(keeperFee(199n, 50)).toBe(0n);
    expect(precheck(facts({ job: { ...facts().job, challengeEnd: NOW } }))).toMatchObject({ kind: 'proceed' });
  });

  it('teslim edilmemiş ya da kapanmış job günlüğe yazılmaz; pencere açıksa bekler', () => {
    expect(precheck(facts({ job: { ...facts().job, status: 'released' } }))).toEqual({
      kind: 'ignore',
      status: 'released',
    });
    expect(precheck(facts({ job: { ...facts().job, challengeEnd: NOW + 1 } }))).toEqual({
      kind: 'skip',
      reason: 'challengeOpen',
    });
  });

  it('satılmış alacakta payee alıcıdır ve screening’i alıcınınkidir', () => {
    const sold = facts({ listing: { status: 'bought', buyer: BUYER } });
    expect(precheck(sold)).toMatchObject({ kind: 'proceed', payee: BUYER });
    expect(precheck(facts({ listing: { status: 'listed', buyer: BUYER } }))).toMatchObject({ payee: AGENT });
  });

  it('policy’li işte ispat yoksa, tüketilmişse ProofRequired; uymuyorsa bayat', () => {
    expect(precheck(withPolicy())).toEqual({ kind: 'skip', reason: 'proofRequired' });
    expect(precheck(withPolicy({ proof: { ...compliant, consumed: true } }))).toEqual({
      kind: 'skip',
      reason: 'proofRequired',
    });
    for (const stale of [{ payee: BUYER }, { netAmount: 1n }, { mint: AGENT }]) {
      expect(precheck(withPolicy({ proof: { ...compliant, ...stale } }))).toEqual({
        kind: 'skip',
        reason: 'staleProof',
      });
    }
    expect(precheck(withPolicy({ proof: compliant }))).toMatchObject({ kind: 'proceed' });
  });

  it('ödeme dalında screening temiz ve taze olmalı; ret içeren ispatta aranmaz (kararı simülasyon verir)', () => {
    for (const screening of [
      null,
      { status: 'flagged' as const, expiresAt: NOW + 10 },
      { status: 'clear' as const, expiresAt: NOW },
    ]) {
      expect(precheck(facts({ payeeScreening: screening }))).toEqual({ kind: 'skip', reason: 'screeningPending' });
    }
    const refused = withPolicy({ proof: { ...compliant, verdict: 'refused' }, payeeScreening: null });
    expect(precheck(refused)).toMatchObject({ kind: 'proceed' });
  });
});

describe('kârlılık', () => {
  const economics = { mintUnitsPerSol: 150_000_000n, minMarginBps: 0 };
  it('maliyet mint birimine yukarı yuvarlanır; ücret maliyeti marjla aşmalı', () => {
    expect(costInMintUnits(1n, economics.mintUnitsPerSol)).toBe(1n);
    expect(costInMintUnits(1_000_000_000n, economics.mintUnitsPerSol)).toBe(150_000_000n);
    // 0,01 SOL maliyet = 1,5 USDC (USDC 6 ondalık).
    expect(profitable(1_500_000n, 10_000_000n, economics)).toBe(true);
    expect(profitable(1_499_999n, 10_000_000n, economics)).toBe(false);
    expect(profitable(1_650_000n, 10_000_000n, { ...economics, minMarginBps: 1_000 })).toBe(true);
    expect(profitable(1_649_999n, 10_000_000n, { ...economics, minMarginBps: 1_000 })).toBe(false);
  });
});

describe('simülasyon hataları ve geri çekilme', () => {
  it('escrow’un bekleme hataları bekletme sebebidir; diğerleri başarısız', () => {
    expect(classifyFailure('proofRequired')).toEqual({ kind: 'skip', reason: 'proofRequired' });
    expect(classifyFailure('staleReleaseProof')).toEqual({ kind: 'skip', reason: 'staleProof' });
    for (const name of ['screeningRequired', 'screeningFlagged', 'screeningExpired']) {
      expect(classifyFailure(name)).toEqual({ kind: 'skip', reason: 'screeningPending' });
    }
    expect(classifyFailure('challengePeriodNotExpired')).toEqual({ kind: 'skip', reason: 'challengeOpen' });
    expect(classifyFailure('invalidStatus')).toEqual({ kind: 'ignore' });
    expect(classifyFailure('mathOverflow')).toEqual({ kind: 'failed', reason: 'programError' });
    expect(classifyFailure(null)).toEqual({ kind: 'failed', reason: 'programError' });
  });

  it('ardışık bekletmede aralık ikiye katlanır, üst sınırda durur', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const backoff = { baseSeconds: 60, maxSeconds: 3_600 };
    const after = (attempt: number) => (nextAttemptAt(now, attempt, backoff).getTime() - now.getTime()) / 1000;
    expect([1, 2, 3, 4, 7, 50].map(after)).toEqual([60, 120, 240, 480, 3_600, 3_600]);
    expect(after(0)).toBe(60);
  });

  it('priority fee yüzdeliği', () => {
    expect(percentile([], 50)).toBe(0n);
    expect(percentile([5n, 1n, 9n, 3n], 50)).toBe(3n);
    expect(percentile([5n, 1n, 9n, 3n], 100)).toBe(9n);
    expect(percentile([5n, 1n, 9n, 3n], 0)).toBe(1n);
  });
});
