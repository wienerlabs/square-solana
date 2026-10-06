// Test fixture: test dosyalarının paylaştığı Postgres konteyneri (migration'lar uygulanmış, db/testing). Dosyalar
// sırayla koşar (vitest.config: fileParallelism false) ve her dosya veritabanını boşaltarak başlar.
import { startIsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const database = await startIsolatedDatabase();
  project.provide('databaseUrl', database.url);
  return async () => {
    await database.stop();
  };
}
