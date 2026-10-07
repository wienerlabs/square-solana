// API işlem şemaları: auth, x402 ücretli uç noktalar, tx hazırlama, teslimat, prover, keeper günlüğü, health.
import { z } from 'zod';
import { InstructionCallSchema } from './generated/idl.js';
import { Address, Base64, Hex32, I64, Signature, U64, hexBytes } from './primitives.js';

// ---------------------------------------------------------------- auth (cüzdan Ed25519 oturumu + API anahtarı)

export const AuthChallengeRequestSchema = z.object({ wallet: Address });
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequestSchema>;

export const AuthChallengeSchema = z.object({
  nonce: z.string().min(16),
  /** Cüzdanın imzalayacağı tam metin (alan adı, nonce ve son geçerlilik zamanını içerir). */
  message: z.string().min(1),
  expiresAt: I64,
});
export type AuthChallenge = z.infer<typeof AuthChallengeSchema>;

export const SessionRequestSchema = z.object({
  wallet: Address,
  nonce: z.string().min(16),
  /** `message`'ın Ed25519 imzası, base58. */
  signature: Signature,
});
export type SessionRequest = z.infer<typeof SessionRequestSchema>;

export const SessionSchema = z.object({ token: z.string().min(1), wallet: Address, expiresAt: I64 });
export type Session = z.infer<typeof SessionSchema>;

export const ApiKeyScopeSchema = z.enum([
  'read',
  'tx:prepare',
  'deliveries:write',
  'agents:write',
  'prove',
  'disputes:write',
  /** Geliştiricinin sunucusu: ücretli uç nokta tanımlarını okur, uzlaştırılan ödemeleri bildirir (FE-22). */
  'x402:serve',
  /** Kurumun ödeme ajanı: fiat işi kayıtlı kartla ya da MPP ile öder, attestation'ı okur (BE-25). */
  'fiat:pay',
  'disputes:read',
]);
export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const ApiKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  /** Anahtarın ilk karakterleri; tamamı yalnızca oluşturulurken bir kez döner. */
  prefix: z.string().min(4).max(16),
  scopes: z.array(ApiKeyScopeSchema).min(1),
  createdAt: I64,
  lastUsedAt: I64.nullable(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyCreateSchema = z.object({
  label: z.string().min(1).max(80),
  scopes: z.array(ApiKeyScopeSchema).min(1),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

export const ApiKeyCreatedSchema = z.object({ apiKey: ApiKeySchema, secret: z.string().min(32) });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;

// ---------------------------------------------------------------- x402 ücretli uç noktalar (FE-22, ADR 0023)

/**
 * x402 v2'nin Solana ağları (CAIP-2). Değerler `@squaresdk/solana-x402`'nin `SOLANA_MAINNET`, `SOLANA_DEVNET` ve
 * `SOLANA_TESTNET`'iyle aynıdır (test: packages/x402/test/definition.test.ts).
 */
export const X402NetworkSchema = z.enum([
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
]);
export type X402Network = z.infer<typeof X402NetworkSchema>;

/** Geliştiricinin sunucusundaki route yolu (Express yolu): `/` ile başlar, boşluk ve sorgu içermez. */
export const X402PathSchema = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, "'/' ile başlayan, sorgusuz yol bekleniyor");

/** Sıfırdan büyük u64: ödeme tutarı mint'in taban biriminde. */
const PositiveU64 = U64.refine((value) => BigInt(value) > 0n, 'tutar sıfırdan büyük olmalı');

export const X402EndpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  path: X402PathSchema,
  description: z.string().max(500).nullable(),
  /** Çağrı başına fiyat, mint'in taban biriminde. */
  amount: PositiveU64,
  mint: Address,
  network: X402NetworkSchema,
  /** Ödemeyi alan cüzdan (ATA'sı mint'e göre türetilir). */
  payTo: Address,
  /** Pasif uç nokta ödeme istemez ve çağrıyı geçirmez. */
  enabled: z.boolean(),
  createdAt: I64,
  updatedAt: I64,
});
export type X402Endpoint = z.infer<typeof X402EndpointSchema>;

export const X402EndpointCreateSchema = z.object({
  name: z.string().min(1).max(80),
  path: X402PathSchema,
  description: z.string().max(500).nullable(),
  amount: PositiveU64,
  mint: Address,
  network: X402NetworkSchema,
  payTo: Address,
  enabled: z.boolean(),
});
export type X402EndpointCreate = z.infer<typeof X402EndpointCreateSchema>;

/** Kısmi güncelleme: verilmeyen alan değişmez; en az bir alan gerekir. */
export const X402EndpointUpdateSchema = z
  .object({
    name: X402EndpointCreateSchema.shape.name.optional(),
    path: X402EndpointCreateSchema.shape.path.optional(),
    description: X402EndpointCreateSchema.shape.description.optional(),
    amount: X402EndpointCreateSchema.shape.amount.optional(),
    mint: X402EndpointCreateSchema.shape.mint.optional(),
    network: X402EndpointCreateSchema.shape.network.optional(),
    payTo: X402EndpointCreateSchema.shape.payTo.optional(),
    enabled: X402EndpointCreateSchema.shape.enabled.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'en az bir alan gerekir');
export type X402EndpointUpdate = z.infer<typeof X402EndpointUpdateSchema>;

/**
 * Geliştiricinin sunucusunun bildirdiği uzlaştırılmış ödeme (`@squaresdk/solana-x402` `paidRouteFromDefinition`,
 * `onPayment`). `fingerprint` ödeme yükünün tekrar koruması kimliğidir (`ReplayStore` `(x402:<ağ>, kimlik)`),
 * `transaction` uzlaştırma makbuzunun (`PAYMENT-RESPONSE`) işlem imzasıdır.
 */
export const X402PaymentReportSchema = z.object({
  fingerprint: z.string().regex(/^(svm|json):[0-9a-f]{64}$/, 'ödeme yükü kimliği bekleniyor'),
  transaction: Signature,
  network: X402NetworkSchema,
  asset: Address,
  amount: PositiveU64,
  payer: Address,
  payTo: Address,
  settledAt: I64,
});
export type X402PaymentReport = z.infer<typeof X402PaymentReportSchema>;

export const X402PaymentSchema = z.object({
  id: z.string().min(1),
  endpointId: z.string().min(1),
  ...X402PaymentReportSchema.shape,
  reportedAt: I64,
});
export type X402Payment = z.infer<typeof X402PaymentSchema>;

/** Ağ ve mint başına tahsil edilen toplam. */
export const X402UsageTotalSchema = z.object({
  network: X402NetworkSchema,
  asset: Address,
  amount: U64,
  payments: z.number().int().min(0),
});
export type X402UsageTotal = z.infer<typeof X402UsageTotalSchema>;

/** Sayfada gösterilen son ödeme sayısı. */
export const X402_RECENT_PAYMENTS = 20;

export const X402EndpointUsageSchema = z.object({
  endpointId: z.string().min(1),
  /** Uzlaştırılmış (ödemeli) çağrı sayısı. */
  payments: z.number().int().min(0),
  totals: z.array(X402UsageTotalSchema),
  lastPaidAt: I64.nullable(),
  /** Son ödemeler, yeniden eskiye. */
  recent: z.array(X402PaymentSchema).max(X402_RECENT_PAYMENTS),
});
export type X402EndpointUsage = z.infer<typeof X402EndpointUsageSchema>;

// ---------------------------------------------------------------- tx hazırlama (8 adım)

/**
 * İmzasız tx isteği. `call` IDL'den üretilir (program + instruction + argümanlar). `accounts`
 * yalnızca türetilemeyen hesapları taşır (imzacılar, dış hesaplar, token hesapları); PDA'lar
 * IDL'deki seed bilgisinden sunucuda çözülür.
 */
export const TxRequestSchema = z.object({
  call: InstructionCallSchema,
  accounts: z.record(z.string(), Address),
  feePayer: Address,
  /** Mikro-lamport cinsinden priority fee; boşsa sunucu profili kullanılır. */
  computeUnitPrice: U64.nullable(),
});
export type TxRequest = z.infer<typeof TxRequestSchema>;

export const UnsignedTxSchema = z.object({
  /** Serileştirilmiş v0 `VersionedTransaction`, imzasız. */
  transaction: Base64,
  blockhash: z.string().min(32),
  lastValidBlockHeight: z.number().int().min(0),
  feePayer: Address,
  /** İmzalaması gereken adresler (fee payer dahil). */
  signers: z.array(Address).min(1),
  addressLookupTables: z.array(Address),
  computeUnitLimit: z.number().int().min(0),
  /** Sunucu tarafı simülasyonun tükettiği compute unit; simülasyon yapılmadıysa null. */
  simulatedUnits: z.number().int().min(0).nullable(),
});
export type UnsignedTx = z.infer<typeof UnsignedTxSchema>;

// ---------------------------------------------------------------- teslimat

export const DeliveryReceiptSchema = z.object({
  /** Yüklenen içeriğin SHA-256'sı; `submit_work`'ün `workHash` argümanı. */
  workHash: Hex32,
  /** `submit_work`'ün `deliveryUri` argümanı (en fazla 128 bayt). */
  deliveryUri: z.string().min(1).max(128),
  contentType: z.string().min(1).max(120),
  size: z.number().int().min(0),
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

// ---------------------------------------------------------------- prover

/**
 * Uzak prover isteği. Güven sınırı: witness politikanın kendisini içerir; servisi işleten
 * taraf politikayı görür. Kurum kendi prover'ını çalıştırmalı ya da in-process proving kullanmalı.
 */
export const ProveRequestSchema = z.object({
  circuit: z.literal('payment-compliance'),
  /** Beklenen zkey'in SHA-256'sı; farklıysa istek reddedilir. */
  artifactVersion: Hex32,
  witness: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});
export type ProveRequest = z.infer<typeof ProveRequestSchema>;

export const ProveResponseSchema = z.object({
  artifactVersion: Hex32,
  proofA: hexBytes(64),
  proofB: hexBytes(128),
  proofC: hexBytes(64),
  /** Release devresinin 13 public sinyali, devre sırasıyla (release-circuit.md §2). */
  publicInputs: z.array(Hex32).length(13),
  provingMs: z.number().int().min(0),
});
export type ProveResponse = z.infer<typeof ProveResponseSchema>;

// ---------------------------------------------------------------- keeper günlüğü

export const KeeperActionKindSchema = z.enum(['finalizePayment', 'executeResolution', 'lapseDispute']);
export const KeeperOutcomeSchema = z.enum(['submitted', 'confirmed', 'skipped', 'failed']);
export const KeeperReasonSchema = z.enum([
  'challengeOpen',
  'proofRequired',
  'staleProof',
  'screeningPending',
  'unprofitable',
  'rpcError',
  'programError',
]);

export const KeeperActionSchema = z.object({
  id: z.string().min(1),
  job: Address,
  action: KeeperActionKindSchema,
  outcome: KeeperOutcomeSchema,
  /** Bekletme veya başarısızlık sebebi; başarılı gönderimde null. */
  reason: KeeperReasonSchema.nullable(),
  signature: Signature.nullable(),
  keeperFee: U64.nullable(),
  at: I64,
  nextAttemptAt: I64.nullable(),
});
export type KeeperAction = z.infer<typeof KeeperActionSchema>;

// ---------------------------------------------------------------- health

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string().min(1),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Health = z.infer<typeof HealthSchema>;
