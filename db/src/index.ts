// @squaresdk/solana-db — tek Postgres veritabanının Prisma istemcisi (BE-04).
// Şema: prisma/schema.prisma; tasarım: docs/design/data-model.md.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { Prisma, PrismaClient } from './generated/prisma/client.js';
export * from './generated/prisma/enums.js';
export type * from './generated/prisma/models.js';

export interface DatabaseClientOptions {
  /** Postgres bağlantı adresi (ör. servisin DATABASE_URL'i). */
  connectionString: string;
}

/** Postgres sürücü adaptörüyle Prisma istemcisi oluşturur. */
export function createDatabaseClient(options: DatabaseClientOptions): PrismaClient {
  if (!options.connectionString) {
    throw new Error('createDatabaseClient: connectionString gerekli');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: options.connectionString }) });
}
