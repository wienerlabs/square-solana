// Test fixture: API'yi üretimdeki gibi kurar (index.ts'in bağlaması) ve yerel bir portta açar. Veritabanı ve
// depo paylaşılan konteynerlerdir (global-setup), zincir ve prover yerel fixture sunucularıdır. İstemci SDK'nın
// `createApiClient`'idir: uçlar sözleşmedeki istemciyle denenir.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabaseClient, type PrismaClient } from '@squaresdk/solana-db';
import { createRateLimiter } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import { createReadApi } from '@squaresdk/solana-indexer/read';
import { createEventWindow, createHealth, createLogger, createServiceMetrics } from '@squaresdk/solana-observability';
import {
  SQUARE_IDLS,
  createApiClient,
  createSquareClient,
  type SquareApi,
  type SquareProgramIds,
} from '@squaresdk/solana-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthService } from '../../src/auth/service.js';
import { createCardService } from '../../src/cards.js';
import { createDeliveryService } from '../../src/deliveries.js';
import { createInstitutionAuthority } from '../../src/institution-authority.js';
import type { OpenApiDocument } from '../../src/openapi.js';
import { createPolicyMetaService } from '../../src/policy-meta.js';
import { createProverProxy } from '../../src/prover.js';
import { createDeliveryStore } from '../../src/storage.js';
import { createKeyring, type Keyring } from '../../src/travel-rule/crypto.js';
import { createTravelRuleService, type TravelRuleService } from '../../src/travel-rule/service.js';
import { createTxBuilder } from '../../src/tx.js';
import { FixtureRpc, startRpc } from './rpc.js';

/** IDL'lerin bildirdiği program kimlikleri. */
export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};
export const PUBLIC_BASE_URL = 'https://api.square.test';
/** Fixture RPC'nin genesis hash'inin ilk 32 karakteri. */
export const CHAIN_REF = new FixtureRpc().genesisHash.slice(0, 32);

export interface ProverFixture {
  /** Sonraki yanıt; null bağlantıyı yanıtsız kapatır. */
  respond: { status: number; body: string } | null;
  readonly requests: { headers: Record<string, unknown>; body: string }[];
}

export interface Stack {
  readonly url: string;
  readonly db: PrismaClient;
  readonly rpc: FixtureRpc;
  readonly prover: ProverFixture;
  readonly deliveryBaseUrl: string;
  readonly client: ReturnType<typeof createSquareClient>;
  readonly travelRule: TravelRuleService;
  /** İç ve bağımlılık hataları (alarm penceresi). */
  readonly errors: { count(): number };
  api(auth?: { session?: string; apiKey?: string }): SquareApi;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startStack(options: {
  openapi: OpenApiDocument;
  rateLimit?: { read: number; write: number };
  deliveryMaxBytes?: number;
  lookupTable?: PublicKey | null;
  clock?: () => number;
  /** Paylaşılan veritabanı yerine başka bir adres (ör. ulaşılamayan veritabanı testi). */
  databaseUrl?: string;
  /** Travel Rule ana anahtar halkası ve saklama süresi. */
  travelRule?: { keyring: Keyring; retentionSeconds: number };
}): Promise<Stack> {
  const db = createDatabaseClient({ connectionString: options.databaseUrl ?? inject('databaseUrl') });
  const s3 = inject('s3');
  const rpc = new FixtureRpc();
  const rpcServer = await startRpc(rpc);
  const prover: ProverFixture = { respond: null, requests: [] };
  const proverServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      prover.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (!prover.respond) {
        req.socket.destroy();
        return;
      }
      res.writeHead(prover.respond.status, { 'content-type': 'application/json' }).end(prover.respond.body);
    });
  });
  const proverUrl = await listen(proverServer);

  const connection = new Connection(rpcServer.url, 'confirmed');
  const client = createSquareClient({ connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
  const log = createLogger({ service: 'api-test', level: 'error' });
  const deliveryBaseUrl = `${s3.endpoint}/${s3.bucket}`;
  const store = createDeliveryStore({
    endpoint: s3.endpoint,
    region: 'us-east-1',
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    forcePathStyle: true,
    publicBaseUrl: deliveryBaseUrl,
  });
  const authority = createInstitutionAuthority({ db, connection });
  const travelRule = createTravelRuleService({
    db,
    client,
    authority,
    keyring: options.travelRule?.keyring ?? createKeyring(new Map([['test', randomBytes(32)]]), 'test'),
    retentionSeconds: options.travelRule?.retentionSeconds ?? 86_400,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const rateStore = createPrismaRateLimitStore(db);
  const limits = options.rateLimit ?? { read: 1_000, write: 1_000 };
  const window = (limit: number) => createRateLimiter({ store: rateStore, rule: { limit, windowSeconds: 60 } });
  const metrics = createServiceMetrics({ service: 'api-test', version: '0.0.0' });
  const errors = createEventWindow({ windowSeconds: 60 });
  const health = createHealth({
    version: '0.0.0',
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      rpc: async () => {
        await connection.getSlot();
      },
      storage: () => store.check(),
    },
    timeoutMs: 5_000,
    logger: log,
  });
  const app = createApp({
    db,
    read: createReadApi({ db, chainRef: CHAIN_REF, registryProgramId: PROGRAM_IDS.registry }),
    auth: createAuthService({
      db,
      domain: 'app.square.test',
      challengeTtlSeconds: 300,
      sessionTtlSeconds: 3_600,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    deliveries: createDeliveryService({ db, store }),
    cards: createCardService({
      db,
      pda: client.pda,
      registryProgramId: PROGRAM_IDS.registry,
      chainRef: CHAIN_REF,
      publicBaseUrl: PUBLIC_BASE_URL,
    }),
    policyMeta: createPolicyMetaService({ db, authority }),
    tx: createTxBuilder({ client, connection, lookupTable: options.lookupTable ?? null, computeUnitPrice: 1_000n }),
    prover: createProverProxy({ url: proverUrl, apiKey: 'prover-service-key', timeoutMs: 2_000 }),
    travelRule,
    limiters: { read: window(limits.read), write: window(limits.write) },
    openapi: options.openapi,
    health,
    metrics,
    log,
    errors,
    corsOrigins: ['https://app.square.test'],
    trustProxyHops: 0,
    jsonMaxBytes: 64 * 1024,
    deliveryMaxBytes: options.deliveryMaxBytes ?? 1024 * 1024,
  });
  const httpServer = createServer(app);
  const url = await listen(httpServer);
  return {
    url,
    db,
    rpc,
    prover,
    deliveryBaseUrl,
    client,
    travelRule,
    errors,
    api: (auth) => createApiClient({ baseUrl: url, ...(auth ? { auth } : {}) }),
    async close() {
      httpServer.closeAllConnections();
      httpServer.close();
      proverServer.closeAllConnections();
      proverServer.close();
      await rpcServer.close();
      await db.$disconnect();
    },
  };
}

/** Testler arası temiz veritabanı (migration tablosu hariç). */
export async function truncate(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename.replaceAll('"', '""')}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
