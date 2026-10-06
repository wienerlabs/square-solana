// Screener API'sinin istek ve yanıt şemaları (OpenAPI belgesi de bunlardan üretilir, openapi.ts). Zarf API
// sözleşmesininkidir (`{ success, data, error, meta }`, api-sdk-contract §4); hata kodları sözleşmenin
// kodlarına screener'ın iki kodunu ekler: `source_unavailable` (bir kaynak yanıt vermedi, karar verilmedi)
// ve `tx_failed` (karar verildi, `record_screening` tx'i yazılamadı). Zamanlar Unix saniyesidir.
import {
  Address,
  ApiErrorCodeSchema,
  Hex32,
  PageQuerySchema,
  ProgramErrorRefSchema,
  ResponseMetaSchema,
  ScreeningStatusSchema,
  Signature,
  UnixSeconds,
} from '@squaresdk/solana-types';
import { z } from 'zod';
import type { DecisionRow } from './store.js';

export const ScreenerErrorCodeSchema = z.enum([...ApiErrorCodeSchema.options, 'source_unavailable', 'tx_failed']);
export type ScreenerErrorCode = z.infer<typeof ScreenerErrorCodeSchema>;

export const ScreenerErrorSchema = z.object({
  code: ScreenerErrorCodeSchema,
  message: z.string(),
  programError: ProgramErrorRefSchema.nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});

export function screenerEnvelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data, error: z.null(), meta: ResponseMetaSchema }),
    z.object({ success: z.literal(false), data: z.null(), error: ScreenerErrorSchema, meta: ResponseMetaSchema }),
  ]);
}

export const ScreenRequestSchema = z.object({ wallet: Address }).strict();
export type ScreenRequest = z.infer<typeof ScreenRequestSchema>;

export const HistoryQuerySchema = PageQuerySchema.strict();

/** Kaynak başına sonuç: karar ve kanıt alanları ya da hata. */
export const SourceOutcomeSchema = z
  .object({
    source: z.enum(['ofac_sdn', 'chainalysis']),
    flagged: z.boolean().optional(),
    error: z.string().optional(),
  })
  .catchall(z.unknown());

export const ScreeningDecisionSchema = z.object({
  id: z.uuid(),
  wallet: Address,
  trigger: z.enum(['request', 'renewal']),
  /** `recorded`: tx onaylandı; `sourceError`: karar verilmedi; `txFailed`: tx yazılamadı. */
  outcome: z.enum(['recorded', 'sourceError', 'txFailed']),
  status: ScreeningStatusSchema.nullable(),
  /** Zincire yazılan `source_hash`: `evidence`'ın RFC 8785 kanonik JSON'unun SHA-256'sı. */
  sourceHash: Hex32.nullable(),
  signature: Signature.nullable(),
  slot: z.number().int().min(0).nullable(),
  /** Zincirdeki kaydın `screened_at` ve `expires_at`'ı. */
  screenedAt: UnixSeconds.nullable(),
  expiresAt: UnixSeconds.nullable(),
  sources: z.array(SourceOutcomeSchema),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  at: UnixSeconds,
});
export type ScreeningDecisionView = z.infer<typeof ScreeningDecisionSchema>;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const num = (value: bigint | null) => (value === null ? null : Number(value));

export function decisionView(row: DecisionRow): ScreeningDecisionView {
  return ScreeningDecisionSchema.parse({
    id: row.id,
    wallet: row.wallet,
    trigger: row.trigger,
    outcome: row.outcome,
    status: row.status,
    sourceHash: row.sourceHash,
    signature: row.signature,
    slot: num(row.slot),
    screenedAt: num(row.screenedAt),
    expiresAt: num(row.expiresAt),
    sources: row.sources,
    evidence: row.evidence,
    error: row.error,
    at: seconds(row.at),
  });
}
