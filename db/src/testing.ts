// Testler için izole veritabanı (BE-04): her çağrı kendi Postgres konteynerini açar, migration'ları
// `prisma migrate deploy` ile uygular ve kapatılınca konteyneri siler. Docker gerekir.
// Kullanan paket `@testcontainers/postgresql`'i devDependency olarak ekler (isteğe bağlı peer).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createDatabaseClient, type PrismaClient } from './index.js';

const run = promisify(execFile);

/** Test konteynerinin imajı; üretimdeki Postgres ana sürümüyle aynı tutulur (BE-05). */
export const TEST_POSTGRES_IMAGE = 'postgres:17-alpine';

/** src/ ve dist/ paket kökünün bir altında. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

/** Prisma CLI'yi bu paketin yapılandırmasıyla (`prisma.config.ts`) verilen veritabanına karşı çalıştırır. */
export async function runPrisma(
  args: readonly string[],
  databaseUrl: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [PRISMA_CLI, ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...extraEnv, DATABASE_URL: databaseUrl },
  });
}

export interface IsolatedDatabase {
  url: string;
  client: PrismaClient;
  /** `_prisma_migrations` dışındaki tüm tabloları boşaltır. */
  truncate(): Promise<void>;
  stop(): Promise<void>;
}

export async function startIsolatedDatabase(): Promise<IsolatedDatabase> {
  const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE).start();
  const url = container.getConnectionUri();
  try {
    await runPrisma(['migrate', 'deploy'], url);
  } catch (error) {
    await container.stop();
    throw error;
  }
  const client = createDatabaseClient({ connectionString: url });
  return {
    url,
    client,
    async truncate() {
      const tables = await client.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      if (tables.length === 0) return;
      const list = tables.map((t) => `"${t.tablename.replaceAll('"', '""')}"`).join(', ');
      await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    },
    async stop() {
      await client.$disconnect();
      await container.stop();
    },
  };
}
