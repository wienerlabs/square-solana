import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { query } from '../utils/database.js';
import { insertUnattestedPayment } from '../models/unattested-payment.js';

/**
 * Stripe reconciler. The webhook handler persists every signature-verified
 * PaymentIntent into verified_payment_intents. The agent / dashboard then
 * anchors a proof on-chain and writes a proof_records row whose payment_id
 * mirrors the PI id. After a configurable delay (default 90s) any
 * verified_payment_intents row that still has no matching proof_records is
 * declared unattested.
 *
 * The delay is the only soft assumption. We are not waiting for the agent
 * to "finish thinking", we are waiting for the on-chain anchor + DB write
 * to complete. Production deploys with longer settlement windows can raise
 * COMPLIANCE_STRIPE_RECONCILE_DELAY_MS without code changes.
 */

interface CandidateRow {
  stripe_payment_intent_id: string;
  amount_cents: string;
  currency: string;
  customer: string | null;
  stripe_paid_at: Date;
}

/**
 * Returns succeeded verified_payment_intents older than the reconcile delay
 * that have neither a matching proof_records row nor an existing
 * unattested_payments row.
 */
async function loadStripeCandidates(): Promise<CandidateRow[]> {
  const cutoffMs = config.watcher.stripeReconcileDelayMs;
  const result = await query<CandidateRow>(
    `SELECT v.stripe_payment_intent_id, v.amount_cents::text, v.currency,
            v.customer, v.stripe_paid_at
       FROM verified_payment_intents v
      WHERE v.status = 'succeeded'
        AND v.created_at < NOW() - ($1 || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM proof_records p
           WHERE p.payment_id = v.stripe_payment_intent_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM unattested_payments u
           WHERE u.source = 'stripe'
             AND u.identifier = v.stripe_payment_intent_id
        )
      ORDER BY v.created_at ASC
      LIMIT 100`,
    [cutoffMs.toString()],
  );
  return result.rows;
}

/**
 * Resolves the operator that owns a given Stripe customer. We map customer
 * to operator via operator_stripe_credentials. PaymentIntents created
 * without a customer (anonymous) cannot be tied back to an operator;
 * those are flagged with operator_id="unknown" so the dashboard still
 * surfaces them under a special bucket.
 */
async function resolveOperatorByCustomer(
  customerId: string | null,
): Promise<string> {
  if (!customerId) return 'unknown';
  const result = await query<{ operator_id: string }>(
    `SELECT operator_id FROM operator_stripe_credentials WHERE stripe_customer_id = $1`,
    [customerId],
  );
  if (result.rows.length === 0) return 'unknown';
  return result.rows[0].operator_id;
}

export interface StripeReconcileSummary {
  readonly candidates_scanned: number;
  readonly unattested_inserted: number;
}

export async function runStripeReconcileTick(): Promise<StripeReconcileSummary> {
  const candidates = await loadStripeCandidates();
  let inserted = 0;
  for (const candidate of candidates) {
    const operatorId = await resolveOperatorByCustomer(candidate.customer);
    const result = await insertUnattestedPayment({
      operator_id: operatorId,
      source: 'stripe',
      identifier: candidate.stripe_payment_intent_id,
      amount_raw: candidate.amount_cents,
      asset: candidate.currency.toLowerCase(),
      counterparty: candidate.customer,
      block_time: candidate.stripe_paid_at,
      reason: 'verified_intent_without_proof',
      raw_event: {
        stripe_payment_intent_id: candidate.stripe_payment_intent_id,
        amount_cents: parseInt(candidate.amount_cents, 10),
        currency: candidate.currency,
        customer: candidate.customer,
        stripe_paid_at: candidate.stripe_paid_at.toISOString(),
      },
    });
    if (result.inserted) inserted += 1;
  }
  return {
    candidates_scanned: candidates.length,
    unattested_inserted: inserted,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

export function startStripeReconciler(): void {
  if (timer) return;
  // Reuse the watcher cadence so the two watchers run on the same tick budget.
  const interval = Math.max(5_000, config.watcher.intervalMs);
  logger.info('Stripe unattested-payment reconciler starting', {
    interval_ms: interval,
    reconcile_delay_ms: config.watcher.stripeReconcileDelayMs,
  });
  const tick = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const summary = await runStripeReconcileTick();
      if (summary.unattested_inserted > 0) {
        logger.warn('Stripe reconciler recorded new unattested payments', {
          new_unattested: summary.unattested_inserted,
        });
      }
    } catch (err) {
      logger.error('Stripe reconciler tick crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tickInFlight = false;
    }
  };
  void tick();
  timer = setInterval(tick, interval);
}

export function stopStripeReconciler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
