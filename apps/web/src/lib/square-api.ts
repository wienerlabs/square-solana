// Square API (BE-18, `apps/api`) istemcisi: sözleşmenin REST istemcisi (`createApiClient`). Okuma uçları
// kimliksizdir; indexer'ın tablolarından ve keeper'ın günlüğünden okur. Yazma uçları cüzdan oturumuyla
// (`Authorization: Bearer`, FE-03) çağrılır.
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, ApiErrorCode, KeeperAction } from '@squaresdk/solana-types';

/** API istemcisi; oturum belirteci verilirse istekler onunla gider. */
export const squareApi = (apiUrl: string, session?: string): SquareApi =>
  createApiClient({ baseUrl: apiUrl, ...(session && { auth: { session } }) });

/** Başarısız API yanıtı: zarfın hata kodu ve API'nin mesajı. */
export class SquareApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly apiMessage: string,
  ) {
    super(`${apiMessage} (${code})`);
    this.name = 'SquareApiError';
  }
}

/** Zarfın verisi; başarısız yanıtta `SquareApiError`. */
export function unwrap<T>(envelope: ApiEnvelope<T>): T {
  if (!envelope.success) throw new SquareApiError(envelope.error.code, envelope.error.message);
  return envelope.data;
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
