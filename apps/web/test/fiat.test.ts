// Fiat rayının arayüz kuralları (FE-20, ADR 0024 / 0026): sente çevrim ve Stripe'ın en düşük tutarı (API'nin
// `chain.ts` kuralı), işin aşaması, makbuz sinyali, attestation imzası, ön denetimin geçerliliği ve fiat uçlarının
// hata zarfındaki ayrıntılarla okunur metni. Ağ kullanılmaz; Stripe ve API'ye karşı akış PR'daki uçtan uca denemededir.
import { Keypair } from '@solana/web3.js';
import type { FiatAttestation } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  amountInCents,
  attestationSignature,
  fiatAmount,
  fiatPaymentErrorText,
  fiatStage,
  formatUsd,
  isFiatJob,
  PRECHECK_VALID_SECS,
  precheckRemaining,
  receiptSignal,
  stripeErrorText,
} from '@/lib/fiat';
import { SquareApiError } from '@/lib/square-api';

const STRIPE_MINIMUM = { minimumAmountMinor: 50 };
const usdc = (base: bigint) => `${Number(base) / 1_000_000} USDC`;
const DAY = 86_400;
const noon = 1_790_000_000 - (1_790_000_000 % DAY) + DAY / 2;

const attestation = (fields: Partial<FiatAttestation> = {}): FiatAttestation => ({
  job: Keypair.generate().publicKey.toBase58(),
  institution: Keypair.generate().publicKey.toBase58(),
  amount: '12500000',
  paymentIntent: 'pi_3QexampleReceipt',
  amountMinor: 1250,
  currency: 'usd',
  customer: null,
  paidAt: noon,
  receiptHash: `${'0'.repeat(62)}2a`,
  authority: Keypair.generate().publicKey.toBase58(),
  signature: bs58.encode(new Uint8Array(64).fill(7)),
  source: 'webhook',
  ...fields,
});

describe('fiat amounts', () => {
  it('turn the settlement unit into cents: 1 cent = 10^(decimals − 2) units', () => {
    expect(amountInCents(12_500_000n, 6)).toBe(1_250n);
    expect(amountInCents(12_500_001n, 6)).toBeNull();
    expect(amountInCents(1_250n, 2)).toBe(1_250n);
    expect(amountInCents(125n, 1)).toBeNull();
    expect(formatUsd(1_250)).toBe('$12.50');
    expect(formatUsd(123_456_789n)).toBe('$1,234,567.89');
  });

  it("are payable by card only in whole cents and from Stripe's minimum", () => {
    expect(fiatAmount(12_500_000n, 6, STRIPE_MINIMUM)).toEqual({ ok: true, cents: 1_250 });
    expect(fiatAmount(500_000n, 6, STRIPE_MINIMUM)).toEqual({ ok: true, cents: 50 });
    expect(fiatAmount(490_000n, 6, STRIPE_MINIMUM)).toEqual({ ok: false, reason: 'Card payments start at $0.50.' });
    expect(fiatAmount(12_500_001n, 6, STRIPE_MINIMUM)).toEqual({
      ok: false,
      reason: 'A card payment is a whole number of cents.',
    });
    expect(fiatAmount(125n, 1, STRIPE_MINIMUM).ok).toBe(false);
  });
});

describe('fiat job', () => {
  it('is told apart by its rail', () => {
    expect(isFiatJob({ rail: { fiat: {} } })).toBe(true);
    expect(isFiatJob({ rail: { escrow: {} } })).toBe(false);
  });

  it('is unpaid once delivered until its payment is attested', () => {
    const paid = attestation();
    expect(fiatStage('open', null)).toEqual({ kind: 'awaitingDelivery' });
    expect(fiatStage('accepted', null)).toEqual({ kind: 'awaitingDelivery' });
    expect(fiatStage('delivered', null)).toEqual({ kind: 'unpaid' });
    expect(fiatStage('delivered', paid)).toEqual({ kind: 'paid', attestation: paid });
    expect(fiatStage('released', paid)).toEqual({ kind: 'released' });
    expect(fiatStage('cancelled', null)).toEqual({ kind: 'cancelled' });
  });
});

describe('receipt and attestation', () => {
  it('give the proof its receipt signal and the transaction its 64-byte signature', () => {
    expect(receiptSignal(attestation())).toBe(42n);
    expect(attestationSignature(attestation())).toEqual(new Uint8Array(64).fill(7));
    expect(() => attestationSignature(attestation({ signature: bs58.encode(new Uint8Array(32)) }))).toThrow(
      'The attestation signature is not 64 bytes.',
    );
  });
});

describe('the check before paying', () => {
  it('holds for the same UTC day, as long as a proof made then could still be bound', () => {
    expect(PRECHECK_VALID_SECS).toBe(540);
    expect(precheckRemaining(noon, noon)).toBe(540);
    expect(precheckRemaining(noon, noon + 500)).toBe(40);
    expect(precheckRemaining(noon, noon + 541)).toBe(0);
    // Gece yarısı sayaç sıfırlanır: aynı ispat ertesi gün için değildir.
    const late = noon + DAY / 2 - 30;
    expect(precheckRemaining(late, late + 10)).toBe(530);
    expect(precheckRemaining(late, late + 40)).toBe(0);
  });
});

describe('payment errors', () => {
  const failed = (code: ConstructorParameters<typeof SquareApiError>[0], details: Record<string, unknown> | null) =>
    new SquareApiError(code, 'api message', null, details);

  it("name the saved card's decline and an authentication request", () => {
    expect(
      fiatPaymentErrorText(
        failed('payment_failed', { code: 'card_declined', declineCode: 'insufficient_funds' }),
        usdc,
      ),
    ).toBe('The saved card was declined (insufficient_funds). Pay with another card in the card form.');
    expect(
      fiatPaymentErrorText(
        failed('payment_failed', { code: 'authentication_required', status: 'requires_action' }),
        usdc,
      ),
    ).toMatch(/^The bank asks the card holder to authenticate this payment/);
    expect(fiatPaymentErrorText(failed('payment_failed', null), usdc)).toBe(
      'The saved card was declined. Pay with another card in the card form.',
    );
  });

  it('explain the public daily ceiling and a job that is not delivered', () => {
    expect(
      fiatPaymentErrorText(
        failed('invalid_input', { dailyCeiling: '100000000', dailySpent: '95000000', amount: '12500000' }),
        usdc,
      ),
    ).toBe(
      'Paying now would take the institution over its public daily ceiling (100 USDC, 95 USDC spent today), so its ' +
        'proof could not be bound. The payment is not taken; the counter resets at midnight UTC.',
    );
    expect(fiatPaymentErrorText(failed('conflict', { status: 'accepted' }), usdc)).toBe(
      'Only a delivered job is paid by card; this job is accepted.',
    );
    expect(fiatPaymentErrorText(failed('payment_unavailable', null))).toMatch(/^Card payments are not available/);
    expect(fiatPaymentErrorText(failed('forbidden', null))).toBe(
      'The API does not allow this wallet to do that. (api message)',
    );
  });

  it("show Stripe's message with its decline code", () => {
    expect(
      stripeErrorText({ message: 'Your card was declined.', decline_code: 'generic_decline', code: 'card_declined' }),
    ).toBe('Your card was declined. (generic_decline)');
    expect(stripeErrorText({ message: 'Your card number is incomplete.', code: 'incomplete_number' })).toBe(
      'Your card number is incomplete. (incomplete_number)',
    );
    expect(stripeErrorText({})).toBe('The card payment did not go through.');
  });
});
