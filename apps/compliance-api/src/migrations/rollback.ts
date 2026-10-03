import { getClient, closePool } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { migrations } from './registry.js';

async function rollbackLastMigration(): Promise<void> {
  const client = await getClient();
  try {
    const result = await client.query<{ name: string }>('SELECT name FROM migrations ORDER BY id DESC LIMIT 1');

    if (result.rows.length === 0) {
      logger.info('No migrations to rollback');
      return;
    }

    const lastMigration = result.rows[0].name;
    const migration = migrations.find((m) => m.name === lastMigration);

    if (!migration) {
      throw new Error(`Migration not found: ${lastMigration}`);
    }

    logger.info(`Rolling back migration: ${lastMigration}`);
    await client.query('BEGIN');
    try {
      await migration.down(client);
      await client.query('DELETE FROM migrations WHERE name = $1', [lastMigration]);
      await client.query('COMMIT');
      logger.info(`Migration rolled back successfully: ${lastMigration}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
    await closePool();
  }
}

rollbackLastMigration().catch((error) => {
  logger.error('Rollback failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
