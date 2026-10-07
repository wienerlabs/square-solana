// Stripe MPP fiat rayı (BE-25, ADR 0024, ADR 0026). Fiat işi kurum Stripe ile öder: tarayıcıda Stripe.js ya da
// kayıtlı kartla off-session (`createFiatPayment`) ya da MPP 402 akışıyla (`payFiatJobMpp`, Stripe Shared Payment
// Token). Başarılı ödemenin kanonik makbuzunun Poseidon commitment'ını MPP authority işe ve tutara bağlayarak imzalar
// (`FiatAttestation`); kurum bunu ispatla birlikte `verify_mpp_payment_proof`'a verir.
import { z } from 'zod';
import { Address, Hex32, I64, Signature, U64 } from './primitives.js';

/** Fiat rayının para birimi (ISO 4217, küçük harf). ADR 0024 §7: USD; 1 sent = 10^(decimals − 2) taban birim. */
export const FiatCurrencySchema = z.enum(['usd']);
export type FiatCurrency = z.infer<typeof FiatCurrencySchema>;

/** Stripe PaymentIntent durumu. */
export const FiatPaymentStatusSchema = z.enum([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
  'processing',
  'requires_capture',
  'canceled',
  'succeeded',
]);
export type FiatPaymentStatus = z.infer<typeof FiatPaymentStatusSchema>;

/** Ödemenin geldiği yol: kurumun oturumu ya da anahtarı (PaymentIntent) veya MPP 402 akışı. */
export const FiatPaymentViaSchema = z.enum(['intent', 'mpp']);
export type FiatPaymentVia = z.infer<typeof FiatPaymentViaSchema>;

/** Attestation'ın kaynağı: imzalı Stripe webhook'u, kurumun mutabakat isteği ya da MPP isteğinin kendisi. */
export const FiatAttestationSourceSchema = z.enum(['webhook', 'reconcile', 'mpp']);
export type FiatAttestationSource = z.infer<typeof FiatAttestationSourceSchema>;

/** Sent cinsinden tutar (Stripe'ın en küçük birimi). */
const AmountMinor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const StripeId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`), `${prefix}_ ile başlayan Stripe kimliği bekleniyor`);

/** İstemcinin Stripe.js ve MPP için ihtiyaç duyduğu herkese açık yapılandırma. */
export const FiatConfigSchema = z.object({
  currency: FiatCurrencySchema,
  /** Stripe.js'in yayımlanabilir anahtarı (`pk_test_…` / `pk_live_…`). */
  publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]+$/),
  /** Attestation'ları imzalayan anahtar; `VerifierConfig.mpp_authority` ile aynıdır. */
  mppAuthority: Address,
  /** MPP challenge'ındaki Stripe profil kimliği: ödeyen SPT'yi bu satıcıya kapsamlar. MPP kapalıysa null. */
  mppNetworkId: z.string().min(1).nullable(),
  /** Stripe'ın en düşük kart ödemesi (sent). */
  minimumAmountMinor: AmountMinor,
});
export type FiatConfig = z.infer<typeof FiatConfigSchema>;

export const FiatSetupIntentCreateSchema = z
  .object({
    /** Job'ları açan kurum anahtarı (`Job.institution`); çağıran onun güncel yetkilisi olmalı. */
    institution: Address,
  })
  .strict();
export type FiatSetupIntentCreate = z.infer<typeof FiatSetupIntentCreateSchema>;

/** Off-session ödeme için kart kaydı: tarayıcı `stripe.confirmCardSetup(clientSecret)` ile onaylar. */
export const FiatSetupIntentSchema = z.object({
  institution: Address,
  customer: StripeId('cus'),
  setupIntent: StripeId('seti'),
  clientSecret: z.string().min(1),
});
export type FiatSetupIntent = z.infer<typeof FiatSetupIntentSchema>;

export const FiatCardSchema = z.object({
  paymentMethod: StripeId('pm'),
  brand: z.string().min(1),
  last4: z.string().regex(/^[0-9]{4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2000),
});
export type FiatCard = z.infer<typeof FiatCardSchema>;

export const FiatCustomerSchema = z.object({
  institution: Address,
  customer: StripeId('cus'),
  /** `setup_intent.succeeded` ile kaydedilen kart; yoksa null. */
  card: FiatCardSchema.nullable(),
});
export type FiatCustomer = z.infer<typeof FiatCustomerSchema>;

export const FiatPaymentCreateSchema = z
  .object({
    /** true: kayıtlı kartla hemen (off-session) öder; false: tarayıcıda onaylanacak PaymentIntent döner. */
    offSession: z.boolean(),
  })
  .strict();
export type FiatPaymentCreate = z.infer<typeof FiatPaymentCreateSchema>;

/**
 * Kanonik Stripe makbuzu ve MPP authority'nin attestation'ı. `receiptHash` =
 * Poseidon(alan(paymentIntent), amountMinor, alan(currency), alan(customer ?? ""), paidAt); alan(s) =
 * Poseidon(UTF-8 baytları 32'ye sıfırla doldurulmuş s'nin iki 16 baytlık yarısı). `signature`,
 * `"square/mpp-attestation/v1" ‖ job ‖ receiptHash ‖ amount (u64 LE)` mesajının ed25519 imzasıdır.
 */
export const FiatAttestationSchema = z.object({
  job: Address,
  institution: Address,
  /** Job'un tutarı, settlement mint'inin taban biriminde (mesajdaki `amount`). */
  amount: U64,
  paymentIntent: StripeId('pi'),
  amountMinor: AmountMinor,
  currency: FiatCurrencySchema,
  customer: StripeId('cus').nullable(),
  paidAt: I64,
  receiptHash: Hex32,
  authority: Address,
  signature: Signature,
  source: FiatAttestationSourceSchema,
});
export type FiatAttestation = z.infer<typeof FiatAttestationSchema>;

export const FiatPaymentSchema = z.object({
  job: Address,
  paymentIntent: StripeId('pi'),
  via: FiatPaymentViaSchema,
  status: FiatPaymentStatusSchema,
  amountMinor: AmountMinor,
  currency: FiatCurrencySchema,
  /** Tarayıcının onaylayacağı sır; ödeme tamamlandıysa null. */
  clientSecret: z.string().min(1).nullable(),
  /** Ödeme bu istekte tamamlandıysa attestation; değilse webhook ya da mutabakat yazar. */
  attestation: FiatAttestationSchema.nullable(),
});
export type FiatPayment = z.infer<typeof FiatPaymentSchema>;

/** Webhook'un yanıtı. */
export const StripeWebhookReceiptSchema = z.object({
  event: StripeId('evt'),
  type: z.string().min(1),
  /** Olay bir kaydı değiştirdi (attestation ya da kart). */
  recorded: z.boolean(),
});
export type StripeWebhookReceipt = z.infer<typeof StripeWebhookReceiptSchema>;
