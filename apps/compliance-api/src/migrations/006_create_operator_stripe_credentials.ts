import type pg from 'pg';

/**
 * Adım 9 — Off-session agent payments.
 *
 * operator_stripe_credentials persists the Stripe Customer + PaymentMethod
 * pair an operator has configured from the dashboard. The agent-service
 * reads this row at the start of every cycle to decide whether the MPP
 * B-flow can run unattended (off_session=true charge against the saved
 * payment method) or must be skipped.
 *
 * Columns:
 *   operator_id              PRIMARY KEY  — Solana wallet pubkey (base58)
 *   stripe_customer_id       cus_...      — created lazily on first save
 *   stripe_payment_method_id pm_...       — confirmed via SetupIntent client-side
 *   card_brand               "visa", "mastercard", … — display only
 *   card_last4               4-digit string — display only
 *   created_at, updated_at   audit timestamps
 *
 * One operator → one saved card. Re-saving overwrites the row (and detaches
 * the previous payment_method on the Stripe side via the route handler).
 */
export async function up(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS operator_stripe_credentials (
      operator_id              VARCHAR(64)  PRIMARY KEY,
      stripe_customer_id       VARCHAR(64)  NOT NULL,
      stripe_payment_method_id VARCHAR(64)  NOT NULL,
      card_brand               VARCHAR(32),
      card_last4               VARCHAR(4),
      created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_operator_stripe_credentials_customer
      ON operator_stripe_credentials(stripe_customer_id);
  `);
}

export async function down(client: pg.PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_operator_stripe_credentials_customer;
    DROP TABLE IF EXISTS operator_stripe_credentials;
  `);
}
