// Test fixture: servisi üretimdeki bağlamayla (service.ts) ve ortamdan okunan yapılandırmayla (config.ts) kurar,
// yerel bir portta açar. Veritabanı paylaşılan konteynerdir (global-setup), zincir yerel fixture RPC'dir. Sponsor
// anahtarı her yığında çalışma anında üretilir. Kullanıcı oturumları ve API anahtarları API'nin tablolarına
// API'nin biçimiyle yazılır (yalnızca SHA-256'ları).
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabaseClient, type ApiKeyScope, type PrismaClient } from '@squaresdk/solana-db';
import { createLogger, type LogRecord } from '@squaresdk/solana-observability';
import { SQUARE_IDLS, type SquareProgramIds } from '@squaresdk/solana-sdk';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { inject } from 'vitest';
import { loadConfig, type FeePayerConfig } from '../../src/config.js';
import { createFeePayerService, type FeePayerService } from '../../src/service.js';
import { FixtureRpc, startRpc } from './rpc.js';

/** IDL'lerin bildirdiği program kimlikleri. */
export const PROGRAM_IDS: SquareProgramIds = {
  registry: new PublicKey(SQUARE_IDLS.registry.address),
  policy: new PublicKey(SQUARE_IDLS.policy.address),
  verifier: new PublicKey(SQUARE_IDLS.verifier.address),
  escrow: new PublicKey(SQUARE_IDLS.escrow.address),
};

export const SPONSOR_BALANCE = 10_000_000_000;

/** Testlerin ortamı; `overrides` tek tek değişkenleri değiştirir. */
export function testEnv(sponsor: Keypair, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://unused',
    FEE_PAYER_PORT: '8080',
    FEE_PAYER_METRICS_PORT: '9090',
    CORS_ORIGINS: 'https://app.square.test',
    FEE_PAYER_TRUST_PROXY_HOPS: '0',
    FEE_PAYER_JSON_MAX_BYTES: '8192',
    FEE_PAYER_RPC_URLS: 'http://127.0.0.1:1',
    FEE_PAYER_RPC_TIMEOUT_MS: '5000',
    FEE_PAYER_RPC_COOLDOWN_MS: '0',
    FEE_PAYER_SECRET_KEY: bs58.encode(sponsor.secretKey),
    FEE_PAYER_MAX_COMPUTE_UNIT_PRICE: '100000',
    FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT: '1400000',
    FEE_PAYER_MAX_LAMPORTS_PER_TX: '20000000',
    FEE_PAYER_USER_DAILY_LAMPORTS: '100000000',
    FEE_PAYER_GLOBAL_DAILY_LAMPORTS: '1000000000',
    FEE_PAYER_RATE_LIMIT_WINDOW_SECONDS: '60',
    FEE_PAYER_RATE_LIMIT: '1000',
    FEE_PAYER_MIN_BALANCE_LAMPORTS: '1000000000',
    FEE_PAYER_ALERT_ERRORS: '0',
    FEE_PAYER_ALERT_ERROR_WINDOW_SECONDS: '60',
    LOG_LEVEL: 'debug',
    HEALTH_CHECK_TIMEOUT_MS: '2000',
    ALERT_EVALUATION_SECONDS: '5',
    ...overrides,
  };
}

export interface Response<T = Record<string, unknown>> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: {
    success: boolean;
    data: T;
    error: { code: string; message: string; details: Record<string, unknown> | null; programError: unknown } | null;
  };
}

export interface Stack {
  readonly url: string;
  readonly metricsUrl: string;
  readonly db: PrismaClient;
  readonly rpc: FixtureRpc;
  readonly sponsor: Keypair;
  readonly config: FeePayerConfig;
  readonly service: FeePayerService;
  /** RPC fixture'ına bağlı bağlantı (SDK akışlarının hesap okumaları için). */
  readonly connection: Connection;
  readonly logs: LogRecord[];
  /** Cüzdan için geçerli bir oturum belirteci. */
  session(wallet: PublicKey, options?: { expired?: boolean; revoked?: boolean }): Promise<string>;
  apiKey(
    wallet: PublicKey,
    scopes: ApiKeyScope[],
    options?: { revoked?: boolean },
  ): Promise<{ id: string; secret: string }>;
  request<T = Record<string, unknown>>(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; raw?: string; headers?: Record<string, string> },
  ): Promise<Response<T>>;
  close(): Promise<void>;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startStack(
  options: {
    env?: Record<string, string>;
    clock?: () => number;
    /** Paylaşılan veritabanı yerine başka bir adres (ör. ulaşılamayan veritabanı testi). */
    databaseUrl?: string;
    /** Fixture yerine gerçek bir RPC (localnet testi). */
    rpcUrl?: string;
  } = {},
): Promise<Stack> {
  const db = createDatabaseClient({ connectionString: options.databaseUrl ?? inject('databaseUrl') });
  const rpc = new FixtureRpc();
  const rpcServer = await startRpc(rpc);
  const sponsor = Keypair.generate();
  rpc.balances.set(sponsor.publicKey.toBase58(), SPONSOR_BALANCE);
  const rpcUrl = options.rpcUrl ?? rpcServer.url;
  const config = loadConfig(testEnv(sponsor, { FEE_PAYER_RPC_URLS: rpcUrl, ...options.env }));
  const connection = new Connection(rpcUrl, 'confirmed');
  const logs: LogRecord[] = [];
  const log = createLogger({
    service: 'fee-payer-test',
    level: 'debug',
    sink: { out: () => undefined, err: () => undefined },
    observers: [(record) => logs.push(record)],
  });
  const service = createFeePayerService({
    config,
    db,
    connection,
    programIds: PROGRAM_IDS,
    log,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const server = createServer(service.app);
  const metricsServer = createServer(service.metricsApp);
  const [url, metricsUrl] = await Promise.all([listen(server), listen(metricsServer)]);

  return {
    url,
    metricsUrl,
    db,
    rpc,
    sponsor,
    config,
    service,
    connection,
    logs,
    async session(wallet, flags = {}) {
      const token = `sqs_${randomBytes(32).toString('base64url')}`;
      const address = wallet.toBase58();
      await db.user.upsert({ where: { wallet: address }, create: { wallet: address }, update: {} });
      await db.session.create({
        data: {
          wallet: address,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + (flags.expired ? -3_600_000 : 7 * 86_400_000)),
          revokedAt: flags.revoked ? new Date() : null,
        },
      });
      return token;
    },
    async apiKey(wallet, scopes, flags = {}) {
      const secret = `sqk_${randomBytes(32).toString('base64url')}`;
      const address = wallet.toBase58();
      await db.user.upsert({ where: { wallet: address }, create: { wallet: address }, update: {} });
      const row = await db.apiKey.create({
        data: {
          wallet: address,
          label: 'test',
          prefix: secret.slice(0, 12),
          secretHash: sha256Hex(secret),
          scopes,
          revokedAt: flags.revoked ? new Date() : null,
        },
      });
      return { id: row.id, secret };
    },
    async request(method, path, requestOptions = {}) {
      const response = await fetch(`${url}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...requestOptions.headers },
        ...(requestOptions.raw !== undefined
          ? { body: requestOptions.raw }
          : requestOptions.body === undefined
            ? {}
            : { body: JSON.stringify(requestOptions.body) }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() } as never;
    },
    async close() {
      await Promise.all(
        [server, metricsServer].map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      );
      await rpcServer.close();
      await db.$disconnect();
    },
  };
}

/** Boş veritabanı: her test dosyası bununla başlar. */
export async function truncate(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE "sponsored_txs", "rate_limit_windows", "api_keys", "sessions", "users" RESTART IDENTITY CASCADE',
  );
}
