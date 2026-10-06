// Finalize, ödeme ve itibar (FE-10): finalize'ın şimdi geçip geçmeyeceği (payee'nin screening'i dahil),
// keeper ücreti, escrow hata kodlarının açıklaması, settlement'ın job event'lerindeki izi, keeper günlüğünün okunması. Event'ler escrow
// IDL'iyle kodlanır; API yerelde dinlenmeyen bir adrestir. Gerçek programlara karşı finalize PR açıklamasındaki
// yerel validator denemesindedir.
import { BorshCoder, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SQUARE_IDLS, type JobAccount } from '@squaresdk/solana-sdk';
import { describe, expect, it } from 'vitest';
import { jobEventsFromLogs, type TimelineEntry } from '@/lib/job-detail';
import {
  finalizeErrorMessage,
  finalizeReadiness,
  keeperFeeOf,
  settlementEvents,
  type PayeeScreening,
} from '@/lib/job-settlement';
import type { ScreeningState } from '@/lib/job-wizard';
import type { ReleaseOutlook } from '@/lib/release-proof';
import { readKeeperJournal, squareApi } from '@/lib/square-api';

const key = () => Keypair.generate().publicKey;
const [escrow, jobKey, payee, keeper] = [key(), key(), key(), key()];
const NOW = 1_790_000_000;
const job = (fields: Partial<JobAccount> = {}) =>
  ({
    status: { delivered: {} },
    amount: new BN(250_000_000),
    challengeEnd: new BN(NOW - 1),
    policy: null,
    ...fields,
  }) as JobAccount;
const proof = { payee, netAmount: 248_750_000n, mint: key(), dailySpentBefore: 0n, proofTimestamp: NOW };
const outlook = (kind: ReleaseOutlook['kind']): ReleaseOutlook =>
  kind === 'noProof'
    ? { kind }
    : kind === 'pays' || kind === 'consumed'
      ? { kind, proof: { ...proof, compliant: true, refusalCode: 0, consumed: kind === 'consumed' } }
      : {
          kind,
          proof: { ...proof, compliant: false, refusalCode: 8, consumed: false },
          reasons: ['A new UTC day started.'],
        };
const screening = (value: ScreeningState): PayeeScreening => ({ state: 'ready', value });
const clear = screening({ state: 'clear', expiresAt: NOW + 86_400, screenedAt: NOW - 60 });

describe('finalize readiness', () => {
  it('pays a delivered job without a policy once the challenge window closes', () => {
    expect(
      finalizeReadiness({ job: job(), chainNow: NOW, keeperFeeBps: 50, release: null, payeeScreening: clear }),
    ).toEqual({
      ready: true,
      outcome: 'pays',
      net: 248_750_000n,
      keeperFee: 1_250_000n,
    });
    expect(
      finalizeReadiness({
        job: job({ challengeEnd: new BN(NOW + 60) }),
        chainNow: NOW,
        keeperFeeBps: 50,
        release: null,
        payeeScreening: clear,
      }),
    ).toEqual({
      ready: false,
      reason: 'The challenge window is open until 2026-09-21T14:14:20Z (chain time); finalize opens then.',
    });
    expect(
      finalizeReadiness({
        job: job({ status: { accepted: {} } }),
        chainNow: NOW,
        keeperFeeBps: 50,
        release: null,
        payeeScreening: clear,
      }),
    ).toEqual({ ready: false, reason: 'Only a delivered job can be finalized.' });
  });

  it('follows the compliance proof on a policy job', () => {
    const gated = job({ policy: key() });
    const readiness = (kind: ReleaseOutlook['kind']) =>
      finalizeReadiness({ job: gated, chainNow: NOW, keeperFeeBps: 50, release: outlook(kind), payeeScreening: clear });
    expect(readiness('pays')).toMatchObject({ ready: true, outcome: 'pays' });
    expect(readiness('refunds')).toMatchObject({ ready: true, outcome: 'refunds', net: 248_750_000n });
    expect(readiness('noProof')).toEqual({
      ready: false,
      reason: 'No compliance proof is bound yet, so the escrow would wait (ProofRequired).',
    });
    expect(readiness('waits')).toMatchObject({ ready: false, reason: expect.stringMatching(/ProofRequired/) });
    expect(readiness('stale')).toEqual({
      ready: false,
      reason: 'The bound proof is stale, so the escrow would wait (StaleReleaseProof): A new UTC day started.',
    });
    // İspat durumu henüz okunmadıysa karar verilmez.
    expect(
      finalizeReadiness({ job: gated, chainNow: NOW, keeperFeeBps: 50, release: null, payeeScreening: clear }),
    ).toMatchObject({ ready: false });
  });

  it("waits for the payee's sanctions screening before a payment, not before a refund", () => {
    const pay = (payeeScreening: PayeeScreening) =>
      finalizeReadiness({ job: job(), chainNow: NOW, keeperFeeBps: 50, release: null, payeeScreening });
    expect(pay(screening({ state: 'missing' }))).toEqual({
      ready: false,
      reason: 'The payee has no sanctions screening on chain, so the escrow would wait (ScreeningRequired).',
    });
    expect(pay(screening({ state: 'flagged', expiresAt: NOW + 86_400, screenedAt: NOW - 60 }))).toEqual({
      ready: false,
      reason: 'The payee is flagged by sanctions screening, so the escrow would wait (ScreeningFlagged).',
    });
    // Okunduğunda temizdi, zincir saatinde süresi doldu: escrow'un kuralı `expires_at > now`.
    expect(pay(screening({ state: 'clear', expiresAt: NOW, screenedAt: NOW - 86_400 }))).toEqual({
      ready: false,
      reason:
        "The payee's sanctions screening expired at 2026-09-21T14:13:20Z (chain time), so the escrow would wait (ScreeningExpired).",
    });
    expect(pay({ state: 'loading' })).toEqual({ ready: false, reason: "Reading the payee's sanctions screening…" });
    expect(pay({ state: 'error', message: 'fetch failed' })).toEqual({
      ready: false,
      reason: "The payee's sanctions screening could not be read: fetch failed",
    });

    // Politikalı işte uyumlu ispatla ödeme de screening'i bekler; kesin retle iade aramaz (escrow ve keeper gibi).
    const gated = (kind: ReleaseOutlook['kind'], payeeScreening: PayeeScreening) =>
      finalizeReadiness({
        job: job({ policy: key() }),
        chainNow: NOW,
        keeperFeeBps: 50,
        release: outlook(kind),
        payeeScreening,
      });
    expect(gated('pays', screening({ state: 'missing' }))).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/\(ScreeningRequired\)/),
    });
    expect(gated('refunds', screening({ state: 'missing' }))).toEqual({
      ready: true,
      outcome: 'refunds',
      net: 248_750_000n,
      keeperFee: 1_250_000n,
    });
    expect(gated('refunds', { state: 'error', message: 'fetch failed' })).toMatchObject({
      ready: true,
      outcome: 'refunds',
    });
  });

  it('gives the keeper the fee and the payee the rest', () => {
    expect(keeperFeeOf(250_000_000n, 50)).toBe(1_250_000n);
    expect(keeperFeeOf(25_510_204n, 200)).toBe(510_204n);
    expect(keeperFeeOf(250_000_000n, 0)).toBe(0n);
  });
});

describe('finalize errors', () => {
  const failure = (code: number) => new Error(`Simulation failed: custom program error: 0x${code.toString(16)}`);

  it('say what to do next', () => {
    expect(finalizeErrorMessage(failure(6039))).toBe(
      'Policy job: a release proof must be bound before release (ProofRequired, 6039). The institution has to bind a compliance proof first.',
    );
    expect(finalizeErrorMessage(failure(6041))).toMatch(
      /StaleReleaseProof, 6041\)\. The bound proof no longer matches/,
    );
    expect(finalizeErrorMessage(failure(6008))).toMatch(/ChallengePeriodNotExpired, 6008\)\. Wait for the challenge/);
    expect(finalizeErrorMessage(failure(6016))).toMatch(/ScreeningExpired, 6016\)\. The payee needs a clear/);
    expect(finalizeErrorMessage(new Error('User rejected the request.'))).toBeNull();
  });
});

describe('settlement events', () => {
  const coder = new BorshCoder(SQUARE_IDLS.escrow as unknown as Idl);
  const events = SQUARE_IDLS.escrow.events as readonly { name: string; discriminator: number[] }[];
  const programData = (name: string, data: Record<string, unknown>) =>
    `Program data: ${Buffer.concat([
      Buffer.from(events.find((e) => e.name === name)!.discriminator),
      coder.types.encode(name, data),
    ]).toString('base64')}`;
  const entries = (signature: string, lines: string[]): TimelineEntry[] =>
    jobEventsFromLogs(
      escrow,
      [`Program ${escrow.toBase58()} invoke [1]`, ...lines, `Program ${escrow.toBase58()} success`],
      jobKey,
    ).map((event) => ({ signature, slot: 1, blockTime: NOW, event }));

  it('reads who was paid, the refund and the keeper', () => {
    const paid = entries('sig-pay', [
      programData('ReleaseVerified', { job: jobKey, payee, net_amount: new BN(248_750_000), release_proof: null }),
      programData('Finalized', { job: jobKey, keeper, keeper_fee: new BN(1_250_000) }),
    ]);
    expect(settlementEvents(paid)).toEqual({
      finalized: { keeper, keeperFee: 1_250_000n, signature: 'sig-pay' },
      paid: { payee, net: 248_750_000n },
      refunded: null,
    });
    const refunded = entries('sig-refund', [
      programData('ReleaseRefused', {
        job: jobKey,
        refusal_code: 8,
        refunded_amount: new BN(248_750_000),
        release_proof: key(),
      }),
    ]);
    expect(settlementEvents(refunded)).toEqual({
      finalized: null,
      paid: null,
      refunded: { amount: 248_750_000n, refusalCode: 8 },
    });
    expect(settlementEvents([])).toEqual({ finalized: null, paid: null, refunded: null });
  });
});

describe('keeper journal', () => {
  it('reports an unreachable API instead of an empty journal', async () => {
    await expect(readKeeperJournal(squareApi('http://127.0.0.1:9'), PublicKey.default.toBase58())).rejects.toThrow();
  });
});
