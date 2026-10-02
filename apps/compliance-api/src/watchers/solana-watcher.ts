import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  fetchEnhancedTransactions,
  isHeliusConfigured,
  type HeliusEnhancedTransaction,
  type HeliusTokenTransfer,
} from '../utils/helius.js';
import { query } from '../utils/database.js';
import { insertUnattestedPayment } from '../models/unattested-payment.js';
import {
  getWatcherCursor,
  upsertWatcherCursor,
  listKnownOperatorIds,
} from '../models/watcher-cursor.js';

/**
 * Solana watcher: pulls every parsed token transfer that left an operator
 * wallet through Helius and cross-checks each one against proof_records.
 * Anything without a matching proof becomes a row in unattested_payments
 * for the dashboard to surface.
 *
 * Trust model: Helius itself is just an indexer; the wallet's authoritative
 * tx list is the chain. We are not granting Helius any signing authority,
 * we only treat it as a faster way to enumerate signatures than scrolling
 * through getSignaturesForAddress + getTransaction by hand. A future swap
 * to a self-hosted Geyser stream is purely a data-source change.
 */

interface ReconcileSummary {
  readonly operator_id: string;
  readonly transactions_scanned: number;
  readonly transfers_evaluated: number;
  readonly unattested_inserted: number;
  readonly skipped_already_attested: number;
  readonly cursor_advanced_to: string | null;
}

const MAX_PAGE_SIZE = 100;
// Bound the per-tick work even when an operator has very high activity so
// one wallet cannot starve the others. We page back at most this many tx
// in a single watcher tick; the next tick continues from the same cursor.
const MAX_TRANSACTIONS_PER_TICK = 300;

/**
 * Pulls enhanced transactions for `walletAddress` walking backwards from the
 * most recent signature until either: (a) we hit the saved cursor, (b) we
 * exhaust MAX_TRANSACTIONS_PER_TICK, (c) Helius returns no more rows. The
 * returned list is newest-first so the caller can advance the cursor to
 * results[0].signature once it has finished reconciling.
 */
async function pullPendingTransactions(
  walletAddress: string,
  cursorSignature: string | null,
): Promise<HeliusEnhancedTransaction[]> {
  const collected: HeliusEnhancedTransaction[] = [];
  let until: string | null = cursorSignature;
  let lastBatchTail: string | null = null;
  // Helius API: walks backwards in time when paginating with `before`. The
  // first call has no `before`, subsequent calls pass the oldest signature
  // we have so far. The `until` field is for "stop once you see this id"
  // semantics, mirroring our cursor.
  while (collected.length < MAX_TRANSACTIONS_PER_TICK) {
    const batch = await fetchEnhancedTransactions(walletAddress, {
      limit: MAX_PAGE_SIZE,
      until: until ?? undefined,
    });
    if (batch.length === 0) break;
    for (const tx of batch) {
      if (cursorSignature && tx.signature === cursorSignature) {
        // Hit the cursor mid-batch; everything after this is already known.
        return collected;
      }
      collected.push(tx);
    }
    if (batch.length < MAX_PAGE_SIZE) break;
    const tail = batch[batch.length - 1]?.signature;
    if (!tail || tail === lastBatchTail) break; // pagination stuck
    lastBatchTail = tail;
  }
  return collected;
}

interface OutgoingTransfer {
  readonly tx: HeliusEnhancedTransaction;
  readonly transfer: HeliusTokenTransfer;
}

function extractOutgoing(
  tx: HeliusEnhancedTransaction,
  walletAddress: string,
  mintAllowList: readonly string[],
): OutgoingTransfer[] {
  const transfers = tx.tokenTransfers ?? [];
  const matches: OutgoingTransfer[] = [];
  for (const transfer of transfers) {
    if (transfer.fromUserAccount !== walletAddress) continue;
    if (transfer.toUserAccount === walletAddress) continue; // self-transfer / WSOL wrap noise
    if (mintAllowList.length > 0 && !mintAllowList.includes(transfer.mint)) continue;
    if (transfer.tokenAmount == null || transfer.tokenAmount <= 0) continue;
    matches.push({ tx, transfer });
  }
  return matches;
}

async function hasMatchingProof(
  operatorId: string,
  signature: string,
): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM proof_records
      WHERE operator_id = $1 AND tx_signature = $2`,
    [operatorId, signature],
  );
  return parseInt(result.rows[0]?.count ?? '0', 10) > 0;
}

export async function reconcileOperatorWallet(
  operatorId: string,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    operator_id: operatorId,
    transactions_scanned: 0,
    transfers_evaluated: 0,
    unattested_inserted: 0,
    skipped_already_attested: 0,
    cursor_advanced_to: null,
  };

  const cursor = await getWatcherCursor(operatorId, 'solana');
  let pending: HeliusEnhancedTransaction[];
  try {
    pending = await pullPendingTransactions(operatorId, cursor?.last_signature ?? null);
  } catch (err) {
    logger.warn('Helius fetch failed for operator', {
      operator_id: operatorId,
      error: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }

  if (pending.length === 0) {
    return summary;
  }

  const mintAllowList = config.watcher.mintAllowList;
  let scanned = 0;
  let transfersEvaluated = 0;
  let unattestedInserted = 0;
  let skipped = 0;

  // Reconcile from oldest to newest so that if we crash mid-loop the
  // next tick can still find an unprocessed cursor pointer that is not
  // ahead of an unprocessed transaction.
  for (let i = pending.length - 1; i >= 0; i--) {
    const tx = pending[i];
    scanned += 1;
    const outgoing = extractOutgoing(tx, operatorId, mintAllowList);
    if (outgoing.length === 0) continue;

    for (const { transfer } of outgoing) {
      transfersEvaluated += 1;
      const matched = await hasMatchingProof(operatorId, tx.signature);
      if (matched) {
        skipped += 1;
        continue;
      }
      const blockTime = tx.timestamp ? new Date(tx.timestamp * 1000) : null;
      const decimals = transfer.tokenStandard === 'NonFungible' ? 0 : 6;
      const amountRaw = BigInt(
        Math.round((transfer.tokenAmount ?? 0) * 10 ** decimals),
      );
      const { inserted } = await insertUnattestedPayment({
        operator_id: operatorId,
        source: 'solana',
        identifier: tx.signature,
        amount_raw: amountRaw,
        asset: transfer.mint,
        counterparty: transfer.toUserAccount,
        block_time: blockTime,
        reason: 'no_proof_record',
        raw_event: {
          signature: tx.signature,
          slot: tx.slot,
          type: tx.type,
          source: tx.source,
          token_transfer: transfer,
        },
      });
      if (inserted) unattestedInserted += 1;
    }
  }

  // Advance cursor only after the entire batch has been processed; if we
  // crashed inside the loop the cursor stays where it was and we re-scan
  // the same window next tick (insert is idempotent on (source, identifier)).
  const newest = pending[0];
  await upsertWatcherCursor({
    operatorId,
    source: 'solana',
    lastSignature: newest.signature,
    lastBlockTime: newest.timestamp ? new Date(newest.timestamp * 1000) : null,
  });

  return {
    operator_id: operatorId,
    transactions_scanned: scanned,
    transfers_evaluated: transfersEvaluated,
    unattested_inserted: unattestedInserted,
    skipped_already_attested: skipped,
    cursor_advanced_to: newest.signature,
  };
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export interface WatcherTickResult {
  readonly operators_scanned: number;
  readonly summaries: readonly ReconcileSummary[];
}

export async function runWatcherTick(): Promise<WatcherTickResult> {
  if (!isHeliusConfigured()) {
    return { operators_scanned: 0, summaries: [] };
  }
  const operators = await listKnownOperatorIds();
  const summaries: ReconcileSummary[] = [];
  for (const operatorId of operators) {
    if (!operatorId) continue;
    try {
      summaries.push(await reconcileOperatorWallet(operatorId));
    } catch (err) {
      logger.error('Solana reconcile failed for operator', {
        operator_id: operatorId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { operators_scanned: operators.length, summaries };
}

/**
 * Boots the polling loop. Idempotent - calling twice is a no-op so the
 * compliance-api can wire startWatcher() into both server start and
 * graceful reload code paths without double-scheduling.
 */
export function startSolanaWatcher(): void {
  if (watcherTimer) return;
  if (!isHeliusConfigured()) {
    logger.warn(
      'Solana unattested-payment watcher not started: HELIUS_API_KEY is not set',
    );
    return;
  }
  const interval = Math.max(5_000, config.watcher.intervalMs);
  logger.info('Solana unattested-payment watcher starting', {
    interval_ms: interval,
    network: config.helius.network,
    mint_filter_count: config.watcher.mintAllowList.length,
  });
  const tick = async (): Promise<void> => {
    if (tickInFlight) return; // skip re-entry if previous tick is still running
    tickInFlight = true;
    try {
      const result = await runWatcherTick();
      if (result.summaries.some((s) => s.unattested_inserted > 0)) {
        logger.warn('Watcher tick recorded new unattested payments', {
          operators_scanned: result.operators_scanned,
          new_unattested: result.summaries.reduce(
            (acc, s) => acc + s.unattested_inserted,
            0,
          ),
        });
      }
    } catch (err) {
      logger.error('Solana watcher tick crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tickInFlight = false;
    }
  };
  // Fire immediately so the first scan does not wait a full interval
  void tick();
  watcherTimer = setInterval(tick, interval);
}

export function stopSolanaWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
