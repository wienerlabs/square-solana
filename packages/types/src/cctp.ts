// CCTP ile fonlama transferi (BE-26, docs/design/cctp-funding.md). Kurum kaynak zincirdeki burn tx'ini bir job'a
// bağlar (`registerCctpTransfer`); relayer Circle'ın attestation'ını izler, mesaj imzalanınca kurum mint ile
// fonlamayı tek tx'te imzalar (`prepareCctpFundTx`). Mesaj ve attestation herkese açıktır.
import { z } from 'zod';
import { UnsignedTxSchema } from './operations.js';
import { Address, Hex32, I64, Signature, U64 } from './primitives.js';

/** Circle domain kimliği (u32): Ethereum 0, Arbitrum 3, Base 6, Solana 5 … */
export const CctpDomain = z.number().int().min(0).max(4_294_967_295);

/** EVM tx hash'i, 0x'li küçük harf hex (yanıtlarda); istekte büyük harf de kabul edilir ve küçültülür. */
export const EvmTxHash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, '0x ile başlayan 32 baytlık EVM tx hash bekleniyor')
  .transform((value) => value.toLowerCase());

const HexBytes = z.string().regex(/^(?:[0-9a-f]{2})+$/, 'küçük harf hex bekleniyor');

export const CctpTransferStatusSchema = z.enum(['pendingAttestation', 'attested', 'received', 'funded', 'failed']);
export type CctpTransferStatus = z.infer<typeof CctpTransferStatusSchema>;

export const CctpTransferCreateSchema = z
  .object({
    /** Burn'ün yapıldığı zincirin Circle domain'i; API'nin desteklediği kaynaklardan biri. */
    sourceDomain: CctpDomain,
    sourceTxHash: EvmTxHash,
    /** Fonlanacak job: `Open`, settlement mint'i USDC, `institution`'ı isteği yapan cüzdan. */
    job: Address,
  })
  .strict();
export type CctpTransferCreate = z.input<typeof CctpTransferCreateSchema>;

export const CctpTransferSchema = z.object({
  id: z.string().uuid(),
  sourceDomain: CctpDomain,
  sourceTxHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  job: Address,
  institution: Address,
  /** Beklenen mint alıcısı: kurumun USDC token hesabı. Burn bu hesaba yapılmalı. */
  mintRecipient: Address,
  status: CctpTransferStatusSchema,
  /** Circle'ın atadığı nonce; attestation'dan önce null. */
  nonce: Hex32.nullable(),
  /** Attestation'lı mesaj ve attestation, hex; `flow.receiveAndFundJob`'a verilebilir. */
  message: HexBytes.nullable(),
  attestation: HexBytes.nullable(),
  /** Yakılan tutar ve attester'ın aldığı ücret; mint edilen `amount − feeExecuted`. */
  amount: U64.nullable(),
  feeExecuted: U64.nullable(),
  minted: U64.nullable(),
  attestedAt: I64.nullable(),
  receiveSignature: Signature.nullable(),
  fundSignature: Signature.nullable(),
  /** Relayer'ın son hatası ya da `failed` sebebi. */
  error: z.string().nullable(),
  /** Relayer'ın bu durumdaki ardışık denemesi ve bir sonraki bakışı. */
  attempts: z.number().int().min(0),
  nextAttemptAt: I64.nullable(),
  createdAt: I64,
  updatedAt: I64,
});
export type CctpTransfer = z.infer<typeof CctpTransferSchema>;

export const CctpTransferQuerySchema = z
  .object({
    job: Address.optional(),
    institution: Address.optional(),
    status: CctpTransferStatusSchema.optional(),
  })
  .strict();
export type CctpTransferQuery = z.infer<typeof CctpTransferQuerySchema>;

export const CctpFundTxRequestSchema = z
  .object({
    feePayer: Address,
    /** Mikro-lamport cinsinden priority fee; boşsa sunucu profili kullanılır. */
    computeUnitPrice: U64.nullable(),
  })
  .strict();
export type CctpFundTxRequest = z.infer<typeof CctpFundTxRequestSchema>;

/**
 * Kurumun imzalayacağı tx. `receiveAndFund`: mesaj henüz teslim edilmedi, mint ve `fund_job` tek tx'te. `fund`:
 * mesaj teslim edildi (relayer ya da başkası), USDC kurumun hesabında; yalnızca `fund_job`.
 */
export const CctpFundTxSchema = z.object({
  step: z.enum(['receiveAndFund', 'fund']),
  transfer: CctpTransferSchema,
  tx: UnsignedTxSchema,
});
export type CctpFundTx = z.infer<typeof CctpFundTxSchema>;
