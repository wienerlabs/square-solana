import { query } from '../utils/database.js';

export type WatcherSource = 'solana' | 'stripe';

export interface WatcherCursor {
  readonly operator_id: string;
  readonly source: WatcherSource;
  readonly last_signature: string | null;
  readonly last_block_time: Date | null;
  readonly updated_at: Date;
}

interface Row {
  operator_id: string;
  source: WatcherSource;
  last_signature: string | null;
  last_block_time: Date | null;
  updated_at: Date;
}

function rowToView(r: Row): WatcherCursor {
  return {
    operator_id: r.operator_id,
    source: r.source,
    last_signature: r.last_signature,
    last_block_time: r.last_block_time,
    updated_at: r.updated_at,
  };
}

export async function getWatcherCursor(
  operatorId: string,
  source: WatcherSource,
): Promise<WatcherCursor | null> {
  const result = await query<Row>(
    `SELECT * FROM watcher_cursors WHERE operator_id = $1 AND source = $2`,
    [operatorId, source],
  );
  return result.rows.length === 0 ? null : rowToView(result.rows[0]);
}

export interface UpsertWatcherCursorInput {
  readonly operatorId: string;
  readonly source: WatcherSource;
  readonly lastSignature: string | null;
  readonly lastBlockTime: Date | null;
}

export async function upsertWatcherCursor(
  input: UpsertWatcherCursorInput,
): Promise<WatcherCursor> {
  const result = await query<Row>(
    `INSERT INTO watcher_cursors (operator_id, source, last_signature, last_block_time, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (operator_id, source) DO UPDATE SET
       last_signature = EXCLUDED.last_signature,
       last_block_time = EXCLUDED.last_block_time,
       updated_at = NOW()
     RETURNING *`,
    [input.operatorId, input.source, input.lastSignature, input.lastBlockTime],
  );
  return rowToView(result.rows[0]);
}

/**
 * Returns the distinct operator_ids the compliance-api has ever recorded
 * proof activity, verified Stripe receipts, or watcher cursors for. The
 * watcher loops over this list each tick so newly connected operators get
 * scanned without an explicit registration step.
 */
export async function listKnownOperatorIds(): Promise<string[]> {
  const result = await query<{ operator_id: string }>(
    `SELECT DISTINCT operator_id FROM (
       SELECT operator_id FROM proof_records
       UNION
       SELECT operator_id FROM attestations
       UNION
       SELECT operator_id FROM watcher_cursors
     ) AS o
     WHERE operator_id IS NOT NULL AND operator_id <> ''`,
    [],
  );
  return result.rows.map((row) => row.operator_id);
}
