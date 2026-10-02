// API işlem şemaları: auth, tx hazırlama, teslimat, prover, keeper günlüğü, health.
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

export const ApiKeyScopeSchema = z.enum(['read', 'tx:prepare', 'deliveries:write', 'agents:write', 'prove']);
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

export const ApiKeyCreateSchema = z.object({ label: z.string().min(1).max(80), scopes: z.array(ApiKeyScopeSchema).min(1) });
export type ApiKeyCreate = z.infer<typeof ApiKeyCreateSchema>;

export const ApiKeyCreatedSchema = z.object({ apiKey: ApiKeySchema, secret: z.string().min(32) });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreatedSchema>;

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
  publicInputs: z.array(Hex32).length(10),
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
