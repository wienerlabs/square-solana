// Test fixture: API'yi üretimdeki gibi kurar (index.ts'in bağlaması) ve yerel bir portta açar. Veritabanı ve
// depo paylaşılan konteynerlerdir (global-setup), zincir ve prover yerel fixture sunucularıdır. İstemci SDK'nın
// `createApiClient`'idir: uçlar sözleşmedeki istemciyle denenir.
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTransferStore, type CctpSettings } from '@squaresdk/solana-cctp';
import { createDatabaseClient, type PrismaClient } from '@squaresdk/solana-db';
import { createRateLimiter, createSecretBox, type SecretBox } from '@squaresdk/solana-hardening';
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
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import Stripe from 'stripe';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { createAuthService } from '../../src/auth/service.js';
import { createCardService } from '../../src/cards.js';
import { createCctpService } from '../../src/cctp.js';
import { createDeliveryService } from '../../src/deliveries.js';
import { createCallerAuthority } from '../../src/caller.js';
import { createArbitrationService } from '../../src/disputes/arbitration.js';
import { createArbitrators, type Arbitrators } from '../../src/disputes/arbitrators.js';
import { createEvidenceService } from '../../src/disputes/evidence.js';
import { createParties } from '../../src/disputes/parties.js';
import { createWebhookService } from '../../src/disputes/webhooks.js';
import { createFiatChain } from '../../src/fiat/chain.js';
import { createMppCharger } from '../../src/fiat/mpp.js';
import { createFiatService } from '../../src/fiat/service.js';
import { createInstitutionAuthority } from '../../src/institution-authority.js';
import type { FiatDeps } from '../../src/routes/fiat.js';
import type { OpenApiDocument } from '../../src/openapi.js';
import { createPolicyMetaService } from '../../src/policy-meta.js';
import { createProverProxy } from '../../src/prover.js';
import { createDeliveryStore, createEvidenceStore } from '../../src/storage.js';
import { createTravelRuleService, type TravelRuleService } from '../../src/travel-rule/service.js';
import { createTxBuilder } from '../../src/tx.js';
import { createX402EndpointService } from '../../src/x402.js';
import { FixtureRpc, startRpc } from './rpc.js';
import { StripeFixture, startStripe } from './stripe.js';

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

/** Fiat rayının test ortamı: fixture Stripe sunucusu ve çalışma anında üretilen sırlar. */
export interface FiatFixture {
  readonly stripe: StripeFixture;
  /** Fixture'a yönlendirilmiş gerçek Stripe SDK'sı (webhook imzası üretmek için). */
  readonly client: Stripe;
  readonly webhookSecret: string;
  readonly authority: Keypair;
  readonly networkId: string | null;
}

export interface Stack {
  readonly url: string;
  readonly db: PrismaClient;
  readonly rpc: FixtureRpc;
  readonly prover: ProverFixture;
  readonly deliveryBaseUrl: string;
  readonly client: ReturnType<typeof createSquareClient>;
  readonly travelRule: TravelRuleService;
  /** Webhook sırlarının kutusu ve arbitrator seti (bildirim testleri gönderiyi bunlarla kurar). */
  readonly box: SecretBox;
  readonly arbitrators: Arbitrators;
  /** İç ve bağımlılık hataları (alarm penceresi). */
  readonly errors: { count(): number };
  /** Fiat rayı açıksa fixture'ı. */
  readonly fiat: FiatFixture | null;
  api(auth?: { session?: string; apiKey?: string; smartAccount?: string }): SquareApi;
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
  evidenceMaxBytes?: number;
  lookupTable?: PublicKey | null;
  /** Fixture RPC yerine gerçek bir küme (localnet uçtan uca testi). */
  rpcUrl?: string;
  clock?: () => number;
  /** Paylaşılan veritabanı yerine başka bir adres (ör. ulaşılamayan veritabanı testi). */
  databaseUrl?: string;
  /** Travel Rule ana anahtar halkası ve saklama süresi. */
  travelRule?: { box: SecretBox; retentionSeconds: number };
  /** CCTP ile fonlama; verilmezse kapalı. */
  cctp?: CctpSettings;
  /** API'yi çağıran web uygulamasının adresi: CORS'a girer, giriş mesajının alanı onun host'udur (web e2e testi). */
  webOrigin?: string;
  /** Fiat rayı: fixture Stripe ya da gerçek Stripe test modu (`stripe` verilirse). */
  fiat?: {
    stripe?: { secretKey: string; publishableKey: string };
    webhookSecret?: string;
    authority?: Keypair;
    /** MPP'nin Stripe profili; null MPP'yi kapatır. */
    networkId?: string | null;
  };
}): Promise<Stack> {
  const webOrigin = options.webOrigin ?? 'https://app.square.test';
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

  const connection = new Connection(options.rpcUrl ?? rpcServer.url, 'confirmed');
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
  const callers = createCallerAuthority({ connection });
  const travelRule = createTravelRuleService({
    db,
    client,
    authority,
    box: options.travelRule?.box ?? createSecretBox({ keys: { test: randomBytes(32) }, activeKeyId: 'test' }),
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
  const read = createReadApi({ db, chainRef: CHAIN_REF, registryProgramId: PROGRAM_IDS.registry });
  const tx = createTxBuilder({
    client,
    connection,
    lookupTable: options.lookupTable ?? null,
    computeUnitPrice: 1_000n,
  });
  const cctp = createCctpService({
    store: createTransferStore(db),
    env: options.cctp
      ? {
          client,
          connection,
          programs: options.cctp.programs,
          cctpLookupTables: options.cctp.lookupTables,
          squareLookupTable: options.lookupTable ?? null,
        }
      : null,
    tx,
    computeUnitPrice: 1_000n,
  });
  const evidenceStore = createEvidenceStore({
    endpoint: s3.endpoint,
    region: 'us-east-1',
    bucket: s3.evidenceBucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    forcePathStyle: true,
  });
  // Anahtar halkası çalışma anında üretilir.
  const box = createSecretBox({ keys: { t1: randomBytes(32) }, activeKeyId: 't1' });
  const arbitrators = createArbitrators({ client, ttlMs: 0, ...(options.clock ? { clock: options.clock } : {}) });
  const evidence = createEvidenceService({
    db,
    store: evidenceStore,
    parties: createParties({ db, connection, arbitrators }),
  });
  const stripeFixture = options.fiat && !options.fiat.stripe ? new StripeFixture() : null;
  const stripeServer = stripeFixture ? await startStripe(stripeFixture) : null;
  let fiat: FiatDeps | null = null;
  let fiatFixture: FiatFixture | null = null;
  if (options.fiat) {
    const stripe = stripeServer
      ? new Stripe(`sk_test_${randomBytes(12).toString('hex')}`, {
          host: '127.0.0.1',
          port: stripeServer.port,
          protocol: 'http',
          maxNetworkRetries: 0,
        })
      : new Stripe(options.fiat.stripe!.secretKey);
    const webhookSecret = options.fiat.webhookSecret ?? `whsec_${randomBytes(24).toString('hex')}`;
    const mppAuthority = options.fiat.authority ?? Keypair.generate();
    const networkId = options.fiat.networkId === undefined ? 'profile_test_fixture' : options.fiat.networkId;
    fiat = {
      service: createFiatService({
        db,
        stripe,
        chain: createFiatChain({ client, connection }),
        authority,
        settings: {
          publishableKey: options.fiat.stripe?.publishableKey ?? `pk_test_${randomBytes(12).toString('hex')}`,
          webhookSecret,
          mppAuthority,
          networkId,
        },
        log,
        ...(options.clock ? { clock: options.clock } : {}),
      }),
      mpp: networkId
        ? createMppCharger({
            stripe,
            secretKey: randomBytes(32).toString('base64'),
            networkId,
            realm: new URL(PUBLIC_BASE_URL).host,
          })
        : null,
      publicBaseUrl: PUBLIC_BASE_URL,
    };
    fiatFixture = { stripe: stripeFixture!, client: stripe, webhookSecret, authority: mppAuthority, networkId };
  }
  const app = createApp({
    db,
    read,
    auth: createAuthService({
      db,
      domain: new URL(webOrigin).host,
      challengeTtlSeconds: 300,
      sessionTtlSeconds: 3_600,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    deliveries: createDeliveryService({ db, store, callers }),
    cards: createCardService({
      db,
      pda: client.pda,
      registryProgramId: PROGRAM_IDS.registry,
      chainRef: CHAIN_REF,
      publicBaseUrl: PUBLIC_BASE_URL,
      callers,
    }),
    policyMeta: createPolicyMetaService({ db, authority }),
    tx,
    evidence,
    arbitration: createArbitrationService({
      db,
      read,
      client,
      tx,
      arbitrators,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    webhooks: createWebhookService({
      db,
      box,
      arbitrators,
      urlPolicy: { allowHttp: false, allowPrivateAddresses: false },
    }),
    evidenceMaxBytes: options.evidenceMaxBytes ?? 1024 * 1024,
    prover: createProverProxy({ url: proverUrl, apiKey: 'prover-service-key', timeoutMs: 2_000 }),
    x402: createX402EndpointService({ db }),
    travelRule,
    cctp,
    fiat,
    limiters: { read: window(limits.read), write: window(limits.write) },
    openapi: options.openapi,
    health,
    metrics,
    log,
    errors,
    corsOrigins: [webOrigin],
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
    box,
    arbitrators,
    errors,
    fiat: fiatFixture,
    api: (auth) => createApiClient({ baseUrl: url, ...(auth ? { auth } : {}) }),
    async close() {
      httpServer.closeAllConnections();
      httpServer.close();
      proverServer.closeAllConnections();
      proverServer.close();
      await rpcServer.close();
      await stripeServer?.close();
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
