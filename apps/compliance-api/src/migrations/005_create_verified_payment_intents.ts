import type pg from 'pg';

/**
 * Adım 8a — Stripe webhook trust anchor.
 *
 * verified_payment_intents persists every Stripe PaymentIntent the
 * compliance-api has received via a signature-verified webhook. The webhook
 * handler does NOT trust the request body alone — it computes the
 * Stripe-Signature HMAC against STRIPE_WEBHOOK_SECRET first and only writes
 * a row when the signature matches.
 *
 * Columns:
 *   stripe_payment_intent_id  PRIMARY KEY  — pi_xxx, idempotent insert
 *   amount_cents              actual cents Stripe charged (audit-canonical)
 *   currency                  ISO 4217, lowercased ("usd")
 *   status                    Stripe PaymentIntent status, only "succeeded"
 *                             rows are usable downstream
 *   customer                  Stripe customer ID or NULL for anonymous
 *   stripe_event_id           the webhook event.id; UNIQUE so Stripe replay
 *                             cannot create duplicate rows
 *   poseidon_hash_hex         deterministic Poseidon commitment over the
 *                             canonical receipt (computed at insert time);
 *                             this is what the ZK circuit will consume as
 *                             public_inputs[9] in Adım 8b
 *   authority_signature_b58   ed25519 signature over poseidon_hash by the
 *                             compliance-api's MPP_AUTHORITY keypair, so
 *                             the on-chain verifier (Adım 8c) can attest the
 *                             Stripe receipt without having Stripe API access
 *   stripe_paid_at            unix timestamp of Stripe's authoritative
 *                             charge completion
 *   created_at                row insertion time
 */
export async function up(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS verified_payment_intents (
      stripe_payment_intent_id   VARCHAR(64)  PRIMARY KEY,
      amount_cents               BIGINT       NOT NULL CHECK (amount_cents > 0),
      currency                   VARCHAR(8)   NOT NULL,
      status                     VARCHAR(32)  NOT NULL,
      customer                   VARCHAR(64),
      stripe_event_id            VARCHAR(64)  NOT NULL UNIQUE,
      poseidon_hash_hex          CHAR(64)     NOT NULL,
      authority_signature_b58    VARCHAR(128) NOT NULL,
      stripe_paid_at             TIMESTAMPTZ  NOT NULL,
      created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_verified_payment_intents_status
      ON verified_payment_intents(status);

    CREATE INDEX IF NOT EXISTS idx_verified_payment_intents_poseidon_hash
      ON verified_payment_intents(poseidon_hash_hex);
  `);
}

export async function down(client: pg.PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_verified_payment_intents_poseidon_hash;
    DROP INDEX IF EXISTS idx_verified_payment_intents_status;
    DROP TABLE IF EXISTS verified_payment_intents;
  `);
}
