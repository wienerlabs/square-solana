// Square API (BE-18, `apps/api`) istemcisi: sözleşmenin REST istemcisi (`createApiClient`). Okuma uçları
// kimliksizdir; indexer'ın tablolarından ve keeper'ın günlüğünden okur.
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import type { KeeperAction } from '@squaresdk/solana-types';

export const squareApi = (apiUrl: string): SquareApi => createApiClient({ baseUrl: apiUrl });

/** Keeper günlüğünde bir job için okunan en fazla deneme. */
export const KEEPER_JOURNAL_LIMIT = 20;

/** Job'un keeper günlüğü (`listKeeperActions`), yeniden eskiye; `total` bütün denemelerin sayısı. */
export async function readKeeperJournal(
  api: SquareApi,
  job: string,
): Promise<{ items: KeeperAction[]; total: number }> {
  const envelope = await api.listKeeperActions({ job, limit: KEEPER_JOURNAL_LIMIT });
  if (!envelope.success) throw new Error(`${envelope.error.message} (${envelope.error.code})`);
  return { items: envelope.data, total: envelope.meta.total ?? envelope.data.length };
}
