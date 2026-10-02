// Tutarlı API yanıt zarfı: { success, data, error, meta }.
import { z } from 'zod';
import { IDL_PROGRAMS } from './generated/idl.js';

const PROGRAM_NAMES = Object.keys(IDL_PROGRAMS) as [keyof typeof IDL_PROGRAMS, ...(keyof typeof IDL_PROGRAMS)[]];

/** API hata kodları. Zincir hataları `program_error` + `programError` ile döner. */
export const ApiErrorCodeSchema = z.enum([
  'invalid_input',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'program_error',
  'simulation_failed',
  'rpc_unavailable',
  'db_unavailable',
  'prover_unavailable',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Program hatası referansı. Kodlar her programda 6000'den başlar; (program, code) çifti tekildir. */
export const ProgramErrorRefSchema = z.object({
  program: z.enum(PROGRAM_NAMES),
  code: z.number().int(),
  name: z.string(),
});
export type ProgramErrorRef = z.infer<typeof ProgramErrorRefSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  programError: ProgramErrorRefSchema.nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Yanıt meta verisi; sayfalı yanıtlarda page/limit/total dolu, diğerlerinde null. */
export const ResponseMetaSchema = z.object({
  requestId: z.string(),
  page: z.number().int().min(1).nullable(),
  limit: z.number().int().min(1).max(200).nullable(),
  total: z.number().int().min(0).nullable(),
});
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

/** `data` şeması verilen başarı/hata zarfı. */
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('success', [
    z.object({ success: z.literal(true), data, error: z.null(), meta: ResponseMetaSchema }),
    z.object({ success: z.literal(false), data: z.null(), error: ApiErrorSchema, meta: ResponseMetaSchema }),
  ]);
}

export type ApiEnvelope<T> =
  | { success: true; data: T; error: null; meta: ResponseMeta }
  | { success: false; data: null; error: ApiError; meta: ResponseMeta };

/** Sayfalama sorgusu. */
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;
