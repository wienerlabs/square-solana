import { query } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export type UnattestedSource = 'solana' | 'stripe';
export type UnattestedStatus = 'open' | 'justified' | 'dismissed';

export interface UnattestedPayment {
  readonly id: string;
  readonly operator_id: string;
  readonly source: UnattestedSource;
  readonly identifier: string;
  readonly amount_raw: string;
  readonly asset: string;
  readonly counterparty: string | null;
  readonly block_time: Date | null;
  readonly detected_at: Date;
  readonly reason: string;
  readonly status: UnattestedStatus;
  readonly justification_note: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: Date | null;
  readonly raw_event: unknown;
}

export interface InsertUnattestedPaymentInput {
  readonly operator_id: string;
  readonly source: UnattestedSource;
  readonly identifier: string;
  readonly amount_raw: bigint | string;
  readonly asset: string;
  readonly counterparty: string | null;
  readonly block_time: Date | null;
  readonly reason: string;
  readonly raw_event: unknown;
}

interface Row {
  id: string;
  operator_id: string;
  source: UnattestedSource;
  identifier: string;
  amount_raw: string;
  asset: string;
  counterparty: string | null;
  block_time: Date | null;
  detected_at: Date;
  reason: string;
  status: UnattestedStatus;
  justification_note: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  raw_event: unknown;
}

function rowToView(r: Row): UnattestedPayment {
  return {
    id: r.id,
    operator_id: r.operator_id,
    source: r.source,
    identifier: r.identifier,
    amount_raw: r.amount_raw,
    asset: r.asset,
    counterparty: r.counterparty,
    block_time: r.block_time,
    detected_at: r.detected_at,
    reason: r.reason,
    status: r.status,
    justification_note: r.justification_note,
    resolved_by: r.resolved_by,
    resolved_at: r.resolved_at,
    raw_event: r.raw_event,
  };
}

/**
 * Idempotent insert keyed on (source, identifier) so re-detecting the same
 * Solana signature or Stripe PaymentIntent never produces duplicates. Returns
 * the row currently in the table; on conflict the existing row wins so any
 * operator-applied status (justified/dismissed) is preserved across watcher
 * cycles.
 */
export async function insertUnattestedPayment(
  input: InsertUnattestedPaymentInput,
): Promise<{ readonly payment: UnattestedPayment; readonly inserted: boolean }> {
  const result = await query<Row & { inserted: boolean }>(
    `WITH ins AS (
       INSERT INTO unattested_payments (
         operator_id, source, identifier, amount_raw, asset,
         counterparty, block_time, reason, raw_event
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source, identifier) DO NOTHING
       RETURNING *, true AS inserted
     )
     SELECT * FROM ins
     UNION ALL
     SELECT *, false AS inserted FROM unattested_payments
       WHERE source = $2 AND identifier = $3
       AND NOT EXISTS (SELECT 1 FROM ins)
     LIMIT 1`,
    [
      input.operator_id,
      input.source,
      input.identifier,
      input.amount_raw.toString(),
      input.asset,
      input.counterparty,
      input.block_time,
      input.reason,
      input.raw_event === undefined ? null : JSON.stringify(input.raw_event),
    ],
  );
  const row = result.rows[0];
  const inserted = Boolean(row.inserted);
  if (inserted) {
    logger.warn('Unattested payment detected', {
      operator_id: input.operator_id,
      source: input.source,
      identifier: input.identifier,
      reason: input.reason,
    });
  }
  return { payment: rowToView(row), inserted };
}

export interface ListUnattestedFilter {
  readonly operatorId?: string;
  readonly status?: UnattestedStatus | 'all';
  readonly source?: UnattestedSource;
  readonly page?: number;
  readonly limit?: number;
}

export interface ListUnattestedResult {
  readonly records: readonly UnattestedPayment[];
  readonly total: number;
}

export async function listUnattestedPayments(
  filter: ListUnattestedFilter,
): Promise<ListUnattestedResult> {
  const page = Math.max(1, filter.page ?? 1);
  const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
  const offset = (page - 1) * limit;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.operatorId) {
    params.push(filter.operatorId);
    clauses.push(`operator_id = $${params.length}`);
  }
  if (filter.status && filter.status !== 'all') {
    params.push(filter.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filter.source) {
    params.push(filter.source);
    clauses.push(`source = $${params.length}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM unattested_payments ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const dataResult = await query<Row>(
    `SELECT * FROM unattested_payments ${where}
     ORDER BY detected_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { records: dataResult.rows.map(rowToView), total };
}

export async function getUnattestedPayment(
  id: string,
): Promise<UnattestedPayment | null> {
  const result = await query<Row>(
    'SELECT * FROM unattested_payments WHERE id = $1',
    [id],
  );
  return result.rows.length === 0 ? null : rowToView(result.rows[0]);
}

export interface ResolveUnattestedInput {
  readonly id: string;
  readonly status: 'justified' | 'dismissed';
  readonly resolvedBy: string;
  readonly note: string | null;
}

export async function resolveUnattestedPayment(
  input: ResolveUnattestedInput,
): Promise<UnattestedPayment | null> {
  const result = await query<Row>(
    `UPDATE unattested_payments
       SET status = $2,
           resolved_by = $3,
           resolved_at = NOW(),
           justification_note = $4
     WHERE id = $1
     RETURNING *`,
    [input.id, input.status, input.resolvedBy, input.note],
  );
  if (result.rows.length === 0) return null;
  logger.info('Unattested payment resolved', {
    id: input.id,
    status: input.status,
    resolved_by: input.resolvedBy,
  });
  return rowToView(result.rows[0]);
}

export interface UnattestedSummary {
  readonly open: number;
  readonly justified: number;
  readonly dismissed: number;
  readonly total: number;
}

export async function summarizeUnattestedByOperator(
  operatorId: string,
): Promise<UnattestedSummary> {
  const result = await query<{ status: UnattestedStatus; count: string }>(
    `SELECT status, COUNT(*)::text AS count
       FROM unattested_payments
      WHERE operator_id = $1
      GROUP BY status`,
    [operatorId],
  );
  const buckets: Record<UnattestedStatus, number> = {
    open: 0,
    justified: 0,
    dismissed: 0,
  };
  for (const row of result.rows) {
    buckets[row.status] = parseInt(row.count, 10);
  }
  return {
    ...buckets,
    total: buckets.open + buckets.justified + buckets.dismissed,
  };
}
