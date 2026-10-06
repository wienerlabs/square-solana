// Keeper günlüğü (`listKeeperActions`): keeper'ın (BE-15) `keeper_actions` tablosuna yazdığı denemeler, yeniden
// eskiye. Zamanlar Unix saniyesidir.
import type { PrismaClient } from '@squaresdk/solana-db';
import { KeeperActionSchema, KeeperOutcomeSchema, Address, type KeeperAction } from '@squaresdk/solana-types';
import { z } from 'zod';

export const KeeperFilterSchema = z.object({ job: Address.optional(), outcome: KeeperOutcomeSchema.optional() });
export type KeeperFilter = z.infer<typeof KeeperFilterSchema>;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export async function listKeeperActions(
  db: PrismaClient,
  filter: KeeperFilter,
  page: { page: number; limit: number },
): Promise<{ items: KeeperAction[]; total: number; page: number; limit: number }> {
  const where = { ...(filter.job ? { job: filter.job } : {}), ...(filter.outcome ? { outcome: filter.outcome } : {}) };
  const [rows, total] = await Promise.all([
    db.keeperAction.findMany({
      where,
      orderBy: [{ at: 'desc' }, { id: 'asc' }],
      skip: (page.page - 1) * page.limit,
      take: page.limit,
    }),
    db.keeperAction.count({ where }),
  ]);
  const items = rows.map((row) =>
    KeeperActionSchema.parse({
      id: row.id,
      job: row.job,
      action: row.action,
      outcome: row.outcome,
      reason: row.reason,
      signature: row.signature,
      keeperFee: row.keeperFee === null ? null : row.keeperFee.toFixed(0),
      at: seconds(row.at),
      nextAttemptAt: row.nextAttemptAt === null ? null : seconds(row.nextAttemptAt),
    }),
  );
  return { items, total, ...page };
}
