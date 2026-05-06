import type pg from 'pg';

/**
 * Adverse-action detection schema.
 *
 * The earlier proof_records / verified_payment_intents tables only capture
 * payments the agent voluntarily attests to. To close the soft-rail trust
 * gap, the compliance-api now runs a watcher that pulls every SPL transfer
 * out of an operator wallet (via Helius) and every Stripe PaymentIntent
 * settled against the operator's customer, then cross-checks them against
 * proof_records. Anything without a matching proof lands here as a row the
 * dashboard surfaces and the operator must justify or dismiss.
 *
 * Columns:
 *   id                 row uuid
 *   operator_id        wallet that originated the payment (Solana) or owns
 *                      the Stripe customer (MPP)
 *   source             'solana' | 'stripe'
 *   identifier         tx_signature for solana, payment_intent id for stripe;
 *                      UNIQUE per source so re-detection is idempotent
 *   amount_raw         smallest unit of the asset (lamports / token base
 *                      units for solana, cents for stripe)
 *   asset              mint address (solana) or currency code (stripe)
 *   counterparty       recipient wallet (solana) or customer id (stripe)
 *   block_time         on-chain block_time / Stripe paid_at
 *   detected_at        when the watcher first saw this payment
 *   reason             why it was flagged ("no_proof_record",
 *                      "verified_intent_without_proof", ...)
 *   status             'open' | 'justified' | 'dismissed'
 *   justification_note operator-supplied free text (optional)
 *   resolved_by        wallet/user that set status away from 'open'
 *   resolved_at        timestamp of the status transition
 *   raw_event          original watcher payload for forensic replay
 *
 * watcher_cursors keeps the per-operator scan position for the Solana
 * watcher so each cycle picks up where the previous one left off without
 * re-scanning the entire signature history.
 */
export async function up(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS unattested_payments (
      id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      operator_id        VARCHAR(64)  NOT NULL,
      source             VARCHAR(16)  NOT NULL CHECK (source IN ('solana', 'stripe')),
      identifier         VARCHAR(128) NOT NULL,
      amount_raw         NUMERIC(40, 0) NOT NULL,
      asset              VARCHAR(64)  NOT NULL,
      counterparty       VARCHAR(128),
      block_time         TIMESTAMPTZ,
      detected_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      reason             VARCHAR(64)  NOT NULL,
      status             VARCHAR(16)  NOT NULL DEFAULT 'open'
                                       CHECK (status IN ('open', 'justified', 'dismissed')),
      justification_note TEXT,
      resolved_by        VARCHAR(128),
      resolved_at        TIMESTAMPTZ,
      raw_event          JSONB,
      UNIQUE (source, identifier)
    );

    CREATE INDEX IF NOT EXISTS idx_unattested_operator
      ON unattested_payments(operator_id);
    CREATE INDEX IF NOT EXISTS idx_unattested_status
      ON unattested_payments(status);
    CREATE INDEX IF NOT EXISTS idx_unattested_operator_status
      ON unattested_payments(operator_id, status);
    CREATE INDEX IF NOT EXISTS idx_unattested_detected_at
      ON unattested_payments(detected_at);

    CREATE TABLE IF NOT EXISTS watcher_cursors (
      operator_id        VARCHAR(64)  NOT NULL,
      source             VARCHAR(16)  NOT NULL CHECK (source IN ('solana', 'stripe')),
      last_signature     VARCHAR(128),
      last_block_time    TIMESTAMPTZ,
      updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (operator_id, source)
    );

    ALTER TABLE attestations
      ADD COLUMN IF NOT EXISTS unattested_count INTEGER NOT NULL DEFAULT 0;
  `);
}

export async function down(client: pg.PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE attestations DROP COLUMN IF EXISTS unattested_count;
    DROP TABLE IF EXISTS watcher_cursors;
    DROP INDEX IF EXISTS idx_unattested_detected_at;
    DROP INDEX IF EXISTS idx_unattested_operator_status;
    DROP INDEX IF EXISTS idx_unattested_status;
    DROP INDEX IF EXISTS idx_unattested_operator;
    DROP TABLE IF EXISTS unattested_payments;
  `);
}
