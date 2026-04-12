import { getClient, closePool } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import * as migration001 from './001_create_compliance_tables.js';
import * as migration002 from './002_add_tx_signature.js';
import * as migration003 from './003_add_proof_tx_signature.js';

interface Migration {
  name: string;
  up: (client: import('pg').PoolClient) => Promise<void>;
  down: (client: import('pg').PoolClient) => Promise<void>;
}

const migrations: Migration[] = [
  { name: '001_create_compliance_tables', ...migration001 },
  { name: '002_add_tx_signature', ...migration002 },
  { name: '003_add_proof_tx_signature', ...migration003 },
];

async function ensureMigrationsTable(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(client: import('pg').PoolClient): Promise<Set<string>> {
  const result = await client.query<{ name: string }>('SELECT name FROM migrations ORDER BY id');
  return new Set(result.rows.map((row) => row.name));
}

async function runMigrations(): Promise<void> {
  const client = await getClient();
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        logger.info(`Migration already applied: ${migration.name}`);
        continue;
      }

      logger.info(`Applying migration: ${migration.name}`);
      await client.query('BEGIN');
      try {
        await migration.up(client);
        await client.query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
        logger.info(`Migration applied successfully: ${migration.name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    logger.info('All migrations completed');
  } finally {
    client.release();
    await closePool();
  }
}

runMigrations().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
