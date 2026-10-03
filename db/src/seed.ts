// `prisma db seed`: referans verisini yazar. Yalnızca yapılandırmadan gelen gerçek değerler
// (program kimlikleri) ve IDL sürümleri; örnek ya da sahte kayıt yoktur.
import { createDatabaseClient } from './index.js';
import { programRowsFromEnv, upsertPrograms } from './programs.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL tanımlı değil');
  const rows = programRowsFromEnv(process.env);
  const client = createDatabaseClient({ connectionString });
  try {
    await upsertPrograms(client, rows);
    process.stdout.write(`${JSON.stringify({ event: 'seeded', programs: rows })}\n`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ event: 'seed_failed', error: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exit(1);
});
