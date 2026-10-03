import type pg from 'pg';

export async function up(client: pg.PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE proof_records
      ADD COLUMN IF NOT EXISTS tx_signature VARCHAR(128) DEFAULT NULL;
  `);
}

export async function down(client: pg.PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE proof_records DROP COLUMN IF EXISTS tx_signature;
  `);
}
