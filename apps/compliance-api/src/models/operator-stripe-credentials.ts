import { query } from '../utils/database.js';
import { logger } from '../utils/logger.js';

export interface OperatorStripeCredentials {
  readonly operator_id: string;
  readonly stripe_customer_id: string;
  readonly stripe_payment_method_id: string;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface Row {
  operator_id: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  card_brand: string | null;
  card_last4: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToView(r: Row): OperatorStripeCredentials {
  return {
    operator_id: r.operator_id,
    stripe_customer_id: r.stripe_customer_id,
    stripe_payment_method_id: r.stripe_payment_method_id,
    card_brand: r.card_brand,
    card_last4: r.card_last4,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function getOperatorStripeCredentials(
  operatorId: string,
): Promise<OperatorStripeCredentials | null> {
  const result = await query<Row>(
    'SELECT * FROM operator_stripe_credentials WHERE operator_id = $1',
    [operatorId],
  );
  if (result.rows.length === 0) return null;
  return rowToView(result.rows[0]);
}

/**
 * Upserts the operator's saved Stripe credentials. Used after a successful
 * SetupIntent confirmation on the dashboard side. The caller is responsible
 * for detaching any prior payment_method on the Stripe API before calling
 * this so a stale token does not linger.
 */
export async function upsertOperatorStripeCredentials(input: {
  readonly operator_id: string;
  readonly stripe_customer_id: string;
  readonly stripe_payment_method_id: string;
  readonly card_brand: string | null;
  readonly card_last4: string | null;
}): Promise<OperatorStripeCredentials> {
  const result = await query<Row>(
    `INSERT INTO operator_stripe_credentials (
       operator_id, stripe_customer_id, stripe_payment_method_id,
       card_brand, card_last4
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (operator_id) DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_payment_method_id = EXCLUDED.stripe_payment_method_id,
       card_brand = EXCLUDED.card_brand,
       card_last4 = EXCLUDED.card_last4,
       updated_at = NOW()
     RETURNING *`,
    [
      input.operator_id,
      input.stripe_customer_id,
      input.stripe_payment_method_id,
      input.card_brand,
      input.card_last4,
    ],
  );
  logger.info('OperatorStripeCredentials persisted', {
    operator_id: input.operator_id,
    customer: input.stripe_customer_id,
    last4: input.card_last4,
  });
  return rowToView(result.rows[0]);
}

export async function deleteOperatorStripeCredentials(
  operatorId: string,
): Promise<boolean> {
  const result = await query(
    'DELETE FROM operator_stripe_credentials WHERE operator_id = $1',
    [operatorId],
  );
  return (result.rowCount ?? 0) > 0;
}
