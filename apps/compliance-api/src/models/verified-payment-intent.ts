import { query } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export interface VerifiedPaymentIntent {
  readonly stripe_payment_intent_id: string;
  readonly amount_cents: number;
  readonly currency: string;
  readonly status: string;
  readonly customer: string | null;
  readonly stripe_event_id: string;
  readonly poseidon_hash_hex: string;
  readonly authority_signature_b58: string;
  readonly stripe_paid_at: Date;
  readonly created_at: Date;
}

interface Row {
  stripe_payment_intent_id: string;
  amount_cents: string;
  currency: string;
  status: string;
  customer: string | null;
  stripe_event_id: string;
  poseidon_hash_hex: string;
  authority_signature_b58: string;
  stripe_paid_at: Date;
  created_at: Date;
}

function rowToView(r: Row): VerifiedPaymentIntent {
  return {
    stripe_payment_intent_id: r.stripe_payment_intent_id,
    amount_cents: parseInt(r.amount_cents, 10),
    currency: r.currency,
    status: r.status,
    customer: r.customer,
    stripe_event_id: r.stripe_event_id,
    poseidon_hash_hex: r.poseidon_hash_hex,
    authority_signature_b58: r.authority_signature_b58,
    stripe_paid_at: r.stripe_paid_at,
    created_at: r.created_at,
  };
}

/**
 * Idempotent insert. Stripe occasionally re-delivers webhooks; using
 * stripe_event_id as a uniqueness check makes the second delivery a no-op.
 * Returns the row that ended up in the table (whether newly inserted or
 * pre-existing), so the caller can always serve a deterministic receipt.
 */
export async function upsertVerifiedPaymentIntent(
  input: Omit<VerifiedPaymentIntent, 'created_at'>,
): Promise<VerifiedPaymentIntent> {
  const result = await query<Row>(
    `INSERT INTO verified_payment_intents (
       stripe_payment_intent_id, amount_cents, currency, status, customer,
       stripe_event_id, poseidon_hash_hex, authority_signature_b58, stripe_paid_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
       status = EXCLUDED.status,
       authority_signature_b58 = EXCLUDED.authority_signature_b58
     RETURNING *`,
    [
      input.stripe_payment_intent_id,
      input.amount_cents,
      input.currency,
      input.status,
      input.customer,
      input.stripe_event_id,
      input.poseidon_hash_hex,
      input.authority_signature_b58,
      input.stripe_paid_at,
    ],
  );
  logger.info('VerifiedPaymentIntent persisted', {
    pi: input.stripe_payment_intent_id,
    status: input.status,
    amount_cents: input.amount_cents,
  });
  return rowToView(result.rows[0]);
}

export async function getVerifiedPaymentIntent(
  paymentIntentId: string,
): Promise<VerifiedPaymentIntent | null> {
  const result = await query<Row>(
    `SELECT * FROM verified_payment_intents WHERE stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  if (result.rows.length === 0) return null;
  return rowToView(result.rows[0]);
}
