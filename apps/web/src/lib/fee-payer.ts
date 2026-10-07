// Sponsorlu işlem servisinin (BE-27, `apps/fee-payer`) istemcisi (FE-21). Servis Square API'nin oturumunu kabul
// eder (`Authorization: Bearer sqs_…`, aynı veritabanı); yanıt zarfı API'ninkidir. Uçların şemaları API
// sözleşmesinde değil, servistedir: yanıtlar burada servisin alanlarıyla (`src/app.ts`, `src/sponsor.ts`) doğrulanır.
// - `GET /v1/sponsor/info`: sponsorun adresi (tx'lerin `feePayer`'ı ve rent ödeyicisi), izinli talimatlar, tavanlar.
// - `GET /v1/sponsor/usage`: çağıranın bugünkü (UTC) harcaması ve günlük bütçesi.
// - `POST /v1/sponsor`: kısmen imzalı v0 tx'i denetler, simüle eder, bütçeden düşer, sponsorla imzalar; `submit: true`
//   ise gönderir. Ret sebebi `error.details.reason`'dadır (servisin README'sindeki tablo).
import type { Idl } from '@anchor-lang/core';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import { Address, envelopeSchema, U64, type ApiEnvelope, type ProgramErrorRef } from '@squaresdk/solana-types';
import { z } from 'zod';

export const SponsorInfoSchema = z.object({
  sponsor: Address,
  allowedInstructions: z.array(z.string()),
  maxComputeUnitPrice: U64,
  maxComputeUnitLimit: z.number().int().positive(),
  maxLamportsPerTx: U64,
  userDailyLamports: U64,
});
export type SponsorInfo = z.infer<typeof SponsorInfoSchema>;

export const SponsorUsageSchema = z.object({
  /** UTC günü (YYYY-MM-DD). */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  spentLamports: U64,
  limitLamports: U64,
  transactions: z.number().int().nonnegative(),
});
export type SponsorUsage = z.infer<typeof SponsorUsageSchema>;

export const SponsorResultSchema = z.object({
  /** Sponsorun imzasını taşıyan tx (base64). */
  transaction: z.string().min(1),
  /** Tx kimliği (ilk imza, sponsorun). */
  signature: z.string().min(1),
  submitted: z.boolean(),
  feeLamports: U64,
  rentLamports: U64,
  computeUnits: z.number().int().nonnegative().nullable(),
  computeUnitLimit: z.number().int().positive(),
  computeUnitPrice: U64,
  instructions: z.array(z.string()),
  dailySpentLamports: U64,
  dailyLimitLamports: U64,
});
export type SponsorResult = z.infer<typeof SponsorResultSchema>;

const InfoEnvelope = envelopeSchema(SponsorInfoSchema);
const UsageEnvelope = envelopeSchema(SponsorUsageSchema);
const ResultEnvelope = envelopeSchema(SponsorResultSchema);

/** Servisin reddi: zarfın hata kodu, servisin mesajı ve politika sebebi. */
export class FeePayerError extends Error {
  constructor(
    readonly code: string,
    readonly serviceMessage: string,
    readonly reason: string | null,
    readonly programError: ProgramErrorRef | null,
  ) {
    super(`${serviceMessage} (${reason ?? code})`);
    this.name = 'FeePayerError';
  }
}

export interface FeePayerApi {
  info(): Promise<ApiEnvelope<SponsorInfo>>;
  usage(): Promise<ApiEnvelope<SponsorUsage>>;
  /** `transaction`: base64 v0 tx; rol imzacılarının imzaları atılmış, sponsorunki boş. */
  sponsor(request: { transaction: string; submit: boolean }): Promise<ApiEnvelope<SponsorResult>>;
}

/** Servis istemcisi; istekler oturumla gider. Zarf dışı yanıt (vekilin HTML hatası) `FeePayerError` olur. */
export function feePayerApi(baseUrl: string, session: string, send: typeof fetch = fetch): FeePayerApi {
  async function request<T>(schema: z.ZodType<ApiEnvelope<T>>, path: string, body?: unknown) {
    const response = await send(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new FeePayerError('invalid_response', `HTTP ${response.status} without a JSON envelope`, null, null);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new FeePayerError('invalid_response', `HTTP ${response.status} with an unexpected body`, null, null);
    }
    return parsed.data;
  }
  return {
    info: () => request(InfoEnvelope, '/v1/sponsor/info'),
    usage: () => request(UsageEnvelope, '/v1/sponsor/usage'),
    sponsor: (body) => request(ResultEnvelope, '/v1/sponsor', body),
  };
}

/** Zarfın verisi; başarısız yanıtta `FeePayerError` (sebebiyle). */
export function unwrapSponsor<T>(envelope: ApiEnvelope<T>): T {
  if (envelope.success) return envelope.data;
  const reason = envelope.error.details?.['reason'];
  throw new FeePayerError(
    envelope.error.code,
    envelope.error.message,
    typeof reason === 'string' ? reason : null,
    envelope.error.programError,
  );
}

/** Servisin ret sebepleri (`apps/fee-payer/README.md`, "Politika") ve arayüzdeki karşılıkları. */
export const SPONSOR_REJECTION_TEXT: Readonly<Record<string, string>> = {
  invalid_transaction: 'The transaction is not a v0 transaction in wire format, or it is larger than 1232 bytes.',
  unsupported_version: 'The sponsor only pays for v0 transactions.',
  fee_payer_mismatch: "The transaction's fee payer is not the sponsor.",
  invalid_signature: 'A signature on the transaction is not valid.',
  missing_signatures: 'The transaction is missing a signature.',
  lookup_table_not_found: 'An address lookup table of the transaction, or one of its entries, is not on chain.',
  program_not_allowed: 'The sponsor does not pay for a program in this transaction.',
  instruction_not_allowed: 'The sponsor does not pay for an instruction in this transaction.',
  sponsor_drain: "The transaction would move the sponsor's SOL.",
  sponsor_account_misuse: "The transaction uses the sponsor's account for more than fees and rent.",
  duplicate_compute_budget: 'The transaction sets its compute budget twice.',
  compute_unit_price_too_high: "The transaction's priority fee is above the sponsor's limit.",
  compute_unit_limit_too_high: "The transaction's compute unit limit is above the sponsor's limit.",
  invalid_squads_message: 'The smart account transaction cannot be decoded.',
  inner_lookup_table: 'The smart account transaction uses an address lookup table inside the vault message.',
  squads_transaction_not_found: 'The smart account transaction being executed is not on chain.',
  squads_accounts_mismatch: "The executed accounts do not match the smart account transaction's message.",
  squads_multisig_not_found: 'The smart account of the vault transaction is not on chain.',
  sponsor_rent_unbounded: 'The sponsor would pay rent for a Token-2022 account whose size it cannot bound.',
  sponsor_rent_extractable: "The sponsor's rent for the smart account would return to another collector.",
  no_square_instruction: 'The sponsor only pays for Square and Squads transactions.',
  simulation_failed: 'The transaction fails in simulation, or its blockhash has expired.',
  tx_cost_too_high: "The transaction's fee and rent are above the sponsor's limit per transaction.",
  daily_budget_exceeded: "Today's sponsored budget for this wallet is used up.",
  global_budget_exceeded: "The sponsor's budget for today is used up.",
  rate_limited: 'Too many sponsored requests; wait a moment and try again.',
  // Sponsor imzaladı; tx blockhash süresince yine de zincire girebilir (BE-27, `send_failed`).
  send_failed: 'Sending the sponsored transaction failed at the RPC. It may still land until its blockhash expires.',
};

/**
 * Arayüz metni: sebebin karşılığı, yoksa servisin mesajı. Simülasyonda program hatası varsa adı, kodu ve IDL'deki
 * açıklaması eklenir.
 */
export function sponsorErrorText(error: unknown): string {
  if (!(error instanceof FeePayerError)) {
    if (error instanceof TypeError) return 'The sponsor service could not be reached.';
    return (error as Error).message;
  }
  const base = (error.reason && SPONSOR_REJECTION_TEXT[error.reason]) ?? error.serviceMessage;
  const program = error.programError;
  if (!program) return base;
  const known = ((SQUARE_IDLS[program.program] as Idl).errors ?? []).find((entry) => entry.code === program.code);
  return `${base} ${program.name} (${program.program}, ${program.code})${known?.msg ? `: ${known.msg}` : '.'}`;
}
