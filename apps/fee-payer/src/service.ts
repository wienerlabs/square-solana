// Servisin parçalarının bağlanması: süreç giriş noktası (index.ts) ve testler aynı bağlamayı kullanır.
import type { PrismaClient } from '@squaresdk/solana-db';
import { createRateLimiter } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createServiceMetrics,
  type Alarms,
  type Logger,
} from '@squaresdk/solana-observability';
import { SQUARE_IDLS, createSquareClient, type SquareProgramIds } from '@squaresdk/solana-sdk';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import type { Connection } from '@solana/web3.js';
import type express from 'express';
import { createApp, createMetricsApp } from './app.js';
import { createAuthenticator } from './auth.js';
import { programKinds } from './catalog.js';
import type { FeePayerConfig } from './config.js';
import { createLedger } from './ledger.js';
import { createSponsorMetrics } from './metrics.js';
import { packageInfo } from './package-info.js';
import { createSponsorService, type SponsorService } from './sponsor.js';

export interface FeePayerService {
  readonly app: express.Express;
  readonly metricsApp: express.Express;
  readonly alarms: Alarms;
  readonly sponsor: SponsorService;
}

export function createFeePayerService(deps: {
  config: FeePayerConfig;
  db: PrismaClient;
  connection: Connection;
  programIds: SquareProgramIds;
  log: Logger;
  clock?: () => number;
}): FeePayerService {
  const { config, db, connection, log } = deps;
  const clock = deps.clock ?? Date.now;
  const client = createSquareClient({ connection, programIds: deps.programIds, commitment: 'confirmed' });
  const metrics = createServiceMetrics({ service: packageInfo.name, version: packageInfo.version });
  const sponsorMetrics = createSponsorMetrics(metrics.registry);
  const errors = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds, clock });

  /** Program hatası; ad sözleşmedeki IDL adıdır (API'nin eşlemesiyle aynı). */
  const programError = (logs: readonly string[]): ProgramErrorRef | null => {
    let mapped: ProgramErrorRef | null;
    try {
      mapped = client.mapError({ logs });
    } catch {
      return null;
    }
    if (!mapped) return null;
    const known = SQUARE_IDLS[mapped.program].errors as readonly { code: number; name: string }[];
    return { ...mapped, name: known.find((error) => error.code === mapped.code)?.name ?? mapped.name };
  };

  const sponsor = createSponsorService({
    connection,
    sponsor: config.sponsor,
    policy: {
      programs: programKinds(deps.programIds),
      allowed: config.allowedInstructions,
      maxComputeUnitPrice: config.limits.maxComputeUnitPrice,
      maxComputeUnitLimit: config.limits.maxComputeUnitLimit,
    },
    ledger: createLedger({
      db,
      userDailyLamports: config.limits.userDailyLamports,
      globalDailyLamports: config.limits.globalDailyLamports,
      clock,
    }),
    metrics: sponsorMetrics,
    maxLamportsPerTx: config.limits.maxLamportsPerTx,
    programError,
  });

  const health = createHealth({
    version: packageInfo.version,
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      rpc: async () => {
        await sponsor.balance();
      },
    },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const minBalance = Number(config.alerts.minBalanceLamports);
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: [
      {
        name: 'fee_payer_errors',
        description: `Son ${config.alerts.errorWindowSeconds} saniyede iç ve bağımlılık hataları eşiğin üstünde`,
        severity: 'critical',
        read: () => errors.count(),
        above: config.alerts.errors,
        forSeconds: 0,
      },
      {
        name: 'fee_payer_balance_low',
        description: `Sponsor bakiyesi ${minBalance} lamport'un altında (değer: eksik lamport)`,
        severity: 'critical',
        read: async () => Math.max(0, minBalance - (await sponsor.balance())),
        above: 0,
        forSeconds: 0,
      },
    ],
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
    clock,
  });

  const limiter = createRateLimiter({
    store: createPrismaRateLimitStore(db),
    rule: { limit: config.rateLimit.limit, windowSeconds: config.rateLimit.windowSeconds },
    clock,
  });
  const info = Object.freeze({
    sponsor: config.sponsor.publicKey.toBase58(),
    allowedInstructions: [...config.allowedInstructions].sort(),
    maxComputeUnitPrice: config.limits.maxComputeUnitPrice.toString(),
    maxComputeUnitLimit: config.limits.maxComputeUnitLimit,
    maxLamportsPerTx: config.limits.maxLamportsPerTx.toString(),
    userDailyLamports: config.limits.userDailyLamports.toString(),
  });
  const app = createApp({
    auth: createAuthenticator({ db, clock }),
    sponsor,
    limiter,
    info,
    health,
    metrics,
    log,
    errors,
    corsOrigins: config.corsOrigins,
    trustProxyHops: config.trustProxyHops,
    jsonMaxBytes: config.jsonMaxBytes,
  });
  return { app, metricsApp: createMetricsApp(metrics.registry, log), alarms, sponsor };
}
