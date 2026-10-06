// Square API (BE-18, `apps/api`) istemcisi: sözleşmenin REST istemcisi (`createApiClient`). Okuma uçları
// kimliksizdir; indexer'ın tablolarından ve keeper'ın günlüğünden okur. Yazma uçları cüzdan oturumuyla
// (`Authorization: Bearer`, FE-03) çağrılır.
import { ApiClientError, createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, ApiErrorCode, KeeperAction, ProgramErrorRef } from '@squaresdk/solana-types';

/**
 * API istemcisi; oturum belirteci verilirse istekler onunla gider. `smartAccount` (Squads multisig) verilirse
 * istekler `X-Square-Smart-Account` başlığını taşır: oturumun cüzdanı, multisig'te `Initiate` yetkili üyeyse
 * multisig'in vault'u adına yazar (FE-21; API sözleşmesi v0.24.0).
 */
export const squareApi = (apiUrl: string, session?: string, smartAccount?: string | null): SquareApi =>
  createApiClient({
    baseUrl: apiUrl,
    ...(session && { auth: { session, ...(smartAccount && { smartAccount }) } }),
  });

/** Başarısız API yanıtı: zarfın hata kodu ve API'nin mesajı. */
export class SquareApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly apiMessage: string,
    readonly programError: ProgramErrorRef | null = null,
  ) {
    super(`${apiMessage} (${code})`);
    this.name = 'SquareApiError';
  }
}

/** Zarfın verisi; başarısız yanıtta `SquareApiError`. */
export function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.success) {
    throw new SquareApiError(envelope.error.code, envelope.error.message, envelope.error.programError);
  }
  return envelope.data;
}

const API_ERROR_TEXT: Readonly<Record<ApiErrorCode, string>> = {
  invalid_input: 'The API rejected the request as invalid.',
  unauthorized: 'The API session is missing or has expired; sign in again.',
  forbidden: 'The API does not allow this wallet to do that.',
  not_found: 'The API does not know this resource yet; the indexer may not have caught up.',
  conflict: 'The API refused because the state changed.',
  rate_limited: 'Too many requests; wait a moment and try again.',
  program_error: 'The program would reject this.',
  simulation_failed: 'The transaction fails in simulation.',
  rpc_unavailable: "The API cannot reach the chain's RPC right now.",
  db_unavailable: 'The API cannot reach its database right now.',
  prover_unavailable: 'The prover is unavailable.',
  internal_error: 'The API failed with an internal error.',
};

export const isUnauthorized = (error: unknown): boolean =>
  (error instanceof SquareApiError && error.code === 'unauthorized') ||
  (error instanceof ApiClientError && error.status === 401);

export function apiErrorText(error: unknown, programHint?: (name: string) => string | null): string {
  const failure =
    error instanceof ApiClientError && error.error
      ? new SquareApiError(error.error.code, error.error.message, error.error.programError)
      : error;
  if (failure instanceof SquareApiError) {
    const base = API_ERROR_TEXT[failure.code] ?? failure.apiMessage;
    const program = failure.programError;
    if (!program) return `${base} (${failure.apiMessage})`;
    const hint = programHint?.(program.name);
    return `${base} ${program.name} (${program.program}, ${program.code})${hint ? `: ${hint}` : '.'}`;
  }
  if (failure instanceof ApiClientError) return `The API answered unexpectedly (HTTP ${failure.status}).`;
  if (failure instanceof TypeError) return 'The Square API could not be reached.';
  return (failure as Error).message;
}

/** Keeper günlüğünde bir job için okunan en fazla deneme. */
export const KEEPER_JOURNAL_LIMIT = 20;

/**
 * Teslim edilmiş job'un (ya da onayı beklenen denemenin) günlüğünün yeniden okunma aralığı. Keeper'ın
 * bekletme ve onay kayıtları zincirde işlem üretmez; sayfanın log aboneliği onları getirmez.
 */
export const KEEPER_JOURNAL_POLL_MS = 15_000;

/** Job'un keeper günlüğü (`listKeeperActions`), yeniden eskiye; `total` bütün denemelerin sayısı. */
export async function readKeeperJournal(
  api: SquareApi,
  job: string,
): Promise<{ items: KeeperAction[]; total: number }> {
  const envelope = await api.listKeeperActions({ job, limit: KEEPER_JOURNAL_LIMIT });
  const items = unwrap(envelope);
  return { items, total: envelope.meta.total ?? items.length };
}
