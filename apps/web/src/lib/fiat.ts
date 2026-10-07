// Fiat rayı (FE-20; ADR 0024, ADR 0026). Kurum fiat işin tutarını USD olarak Square'in Stripe hesabına öder:
// tarayıcıda kartla (Stripe.js) ya da kayıtlı kartla. MPP authority makbuzu işe ve tutara bağlayarak imzalar
// (attestation); kurum uyum ispatını makbuzla üretip `verify_mpp_payment_proof` ile bağlar ve
// `finalize_fiat_payment` işi `Released` yapar. Agent'a USD ödemesi (Stripe Connect) bu sürümde yoktur (ADR 0026
// madde 1). Ödeme alınıp ispat bağlanamazsa para iade edilemez; bu yüzden gizli politika ödemeden önce kurumun
// tarayıcısında denetlenir (ADR 0026 açık noktalar).
import { CLOCK_TOLERANCE_SECS, dayStart } from '@squaresdk/solana-policy';
import type { JobAccount } from '@squaresdk/solana-sdk';
import type { FiatAttestation, FiatConfig, FiatPaymentStatus } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { apiErrorText, SquareApiError } from './square-api';

export const isFiatJob = (job: Pick<JobAccount, 'rail'>): boolean => 'fiat' in job.rail;

/** Sent için en az iki ondalık: 1 sent = 10^(decimals − 2) taban birim (ADR 0024 §7). */
const CENT_DECIMALS = 2;

export const formatUsd = (cents: number | bigint): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents) / 100);

/** Tutarın sent karşılığı; mint'in iki ondalığı yoksa ya da tutar tam sent değilse null. */
export function amountInCents(amount: bigint, decimals: number): bigint | null {
  if (decimals < CENT_DECIMALS) return null;
  const unit = 10n ** BigInt(decimals - CENT_DECIMALS);
  return amount % unit === 0n ? amount / unit : null;
}

export type FiatAmount = { ok: true; cents: number } | { ok: false; reason: string };

/**
 * Kartla ödenecek tutar. API ile aynı kural (`apps/api/src/fiat/chain.ts`): tutar tam sent olmalı ve Stripe'ın en
 * düşük kart ödemesinden az olmamalı; böyle olmayan fiat iş zincirde açılır ama ödenemez.
 */
export function fiatAmount(
  amount: bigint,
  decimals: number,
  config: Pick<FiatConfig, 'minimumAmountMinor'>,
): FiatAmount {
  if (decimals < CENT_DECIMALS) {
    return { ok: false, reason: 'The settlement mint has fewer than two decimals, so its amounts are not in cents.' };
  }
  const cents = amountInCents(amount, decimals);
  if (cents === null) return { ok: false, reason: 'A card payment is a whole number of cents.' };
  if (cents < BigInt(config.minimumAmountMinor)) {
    return { ok: false, reason: `Card payments start at ${formatUsd(config.minimumAmountMinor)}.` };
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'The amount is above a card payment.' };
  return { ok: true, cents: Number(cents) };
}

/** Stripe PaymentIntent durumunun arayüz metni. */
export const PAYMENT_STATUS_TEXT: Readonly<Record<FiatPaymentStatus, string>> = {
  requires_payment_method: 'Waiting for a card',
  requires_confirmation: 'Waiting for confirmation',
  requires_action: 'Waiting for the card holder to authenticate',
  processing: 'Processing',
  requires_capture: 'Authorized, not captured',
  canceled: 'Canceled',
  succeeded: 'Paid',
};

/** Attestation'ın ispattaki 12. sinyali: makbuz commitment'ı (hex) bir alan elemanı olarak. */
export const receiptSignal = (attestation: Pick<FiatAttestation, 'receiptHash'>): bigint =>
  BigInt(`0x${attestation.receiptHash}`);

/** MPP authority'nin attestation mesajı üzerindeki 64 baytlık ed25519 imzası (zarfta base58). */
export function attestationSignature(attestation: Pick<FiatAttestation, 'signature'>): Uint8Array {
  const signature = bs58.decode(attestation.signature);
  if (signature.length !== 64) throw new Error('The attestation signature is not 64 bytes.');
  return signature;
}

/**
 * Ödemeden önceki uyum denetiminin makbuz sinyali. Devrede 12. sinyal ret koduna girmez, yalnızca public girdi
 * olarak taşınır (`payment.circom`); ödeme yapılmadan önce ret kodunu bulmak için sıfır olmayan herhangi bir değer
 * yeter. Bu ispat bağlanmaz: bağlanacak ispat gerçek makbuzla yeniden üretilir.
 */
export const PRECHECK_RECEIPT_SIGNAL = 1n;

/**
 * Ön denetimin geçerli sayıldığı süre (zincir saniyesi). Denetim yapıldığı an içindir: politika zaman penceresine ve
 * günlük sayaca bağlıdır. Ödeme ve bağlanacak ispat aynı UTC gününde ve ispatın bağlanabileceği süre içinde
 * (600 s, gönderim payıyla 60 s erken) kalırsa denetlenen an değişmez; değilse denetim yenilenir.
 */
export const PRECHECK_VALID_SECS = CLOCK_TOLERANCE_SECS - 60;

/** Ön denetimin şimdi için kalan süresi; geçmişse ya da UTC günü değiştiyse 0. */
export const precheckRemaining = (madeAt: number, chainNow: number): number =>
  dayStart(madeAt) === dayStart(chainNow) ? Math.max(0, PRECHECK_VALID_SECS - (chainNow - madeAt)) : 0;

/** Fiat işin şimdiki aşaması: arayüzün hangi adımı göstereceği. */
export type FiatStage =
  | { kind: 'awaitingDelivery' }
  | { kind: 'unpaid' }
  | { kind: 'paid'; attestation: FiatAttestation }
  | { kind: 'released' }
  | { kind: 'cancelled' };

export function fiatStage(status: string, attestation: FiatAttestation | null): FiatStage {
  switch (status) {
    case 'released':
      return { kind: 'released' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'delivered':
      return attestation ? { kind: 'paid', attestation } : { kind: 'unpaid' };
    default:
      return { kind: 'awaitingDelivery' };
  }
}

/**
 * Stripe'ın kart hatasının okunur hâli (`error.decline_code` ya da `error.code`); Stripe'ın mesajı müşteriye
 * gösterilecek biçimdedir.
 */
export function stripeErrorText(error: { message?: string; decline_code?: string; code?: string }): string {
  const reason = error.decline_code ?? error.code;
  const message = error.message ?? 'The card payment did not go through.';
  return reason ? `${message} (${reason})` : message;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Fiat uçlarının hatası, zarfın ayrıntılarıyla (`details`): kayıtlı kartın reddi (`payment_failed`: Stripe'ın
 * `code` ve `declineCode`'u), günlük tavan (`invalid_input`: `dailyCeiling`, `dailySpent`), teslim edilmemiş iş
 * (`conflict`: `status`).
 */
export function fiatPaymentErrorText(
  error: unknown,
  formatAmount: (base: bigint) => string = (base) => base.toString(),
): string {
  if (!(error instanceof SquareApiError)) return apiErrorText(error);
  const details = error.details ?? {};
  if (error.code === 'payment_failed') {
    if (details['code'] === 'authentication_required') {
      return 'The bank asks the card holder to authenticate this payment: pay with the card form, which asks for it.';
    }
    const reason = text(details['declineCode']) ?? text(details['code']);
    return `The saved card was declined${reason ? ` (${reason})` : ''}. Pay with another card in the card form.`;
  }
  const ceiling = text(details['dailyCeiling']);
  const spent = text(details['dailySpent']);
  if (error.code === 'invalid_input' && ceiling !== null && spent !== null) {
    return (
      `Paying now would take the institution over its public daily ceiling (${formatAmount(BigInt(ceiling))}, ` +
      `${formatAmount(BigInt(spent))} spent today), so its proof could not be bound. The payment is not taken; ` +
      'the counter resets at midnight UTC.'
    );
  }
  const status = text(details['status']);
  if (error.code === 'conflict' && status !== null) {
    return `Only a delivered job is paid by card; this job is ${status}.`;
  }
  if (error.code === 'payment_unavailable') {
    return 'Card payments are not available on this Square API right now (the fiat rail is not configured or Stripe did not answer).';
  }
  return apiErrorText(error);
}
