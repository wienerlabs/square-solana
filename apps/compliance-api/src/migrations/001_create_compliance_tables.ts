import type pg from 'pg';

export async function up(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    CREATE TABLE IF NOT EXISTS proof_records (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      operator_id VARCHAR(64) NOT NULL,
      policy_id VARCHAR(64) NOT NULL,
      payment_id VARCHAR(255) NOT NULL UNIQUE,
      proof_hash VARCHAR(64) NOT NULL,
      amount_range_min NUMERIC(20, 6) NOT NULL,
      amount_range_max NUMERIC(20, 6) NOT NULL,
      token_mint VARCHAR(64) NOT NULL,
      is_compliant BOOLEAN NOT NULL,
      verified_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_proof_records_operator_id ON proof_records(operator_id);
    CREATE INDEX idx_proof_records_policy_id ON proof_records(policy_id);
    CREATE INDEX idx_proof_records_verified_at ON proof_records(verified_at);
    CREATE INDEX idx_proof_records_operator_period ON proof_records(operator_id, verified_at);

    CREATE TABLE IF NOT EXISTS attestations (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      operator_id VARCHAR(64) NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      total_payments INTEGER NOT NULL DEFAULT 0,
      total_amount_range_min NUMERIC(20, 6) NOT NULL DEFAULT 0,
      total_amount_range_max NUMERIC(20, 6) NOT NULL DEFAULT 0,
      policy_violations INTEGER NOT NULL DEFAULT 0,
      sanctions_intersections INTEGER NOT NULL DEFAULT 0,
      proof_hashes TEXT[] NOT NULL DEFAULT '{}',
      batch_proof_hash VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_attestations_operator_id ON attestations(operator_id);
    CREATE INDEX idx_attestations_status ON attestations(status);
    CREATE INDEX idx_attestations_period ON attestations(operator_id, period_start, period_end);

    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function down(client: pg.PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS attestations;
    DROP TABLE IF EXISTS proof_records;
    DROP TABLE IF EXISTS migrations;
  `);
}
