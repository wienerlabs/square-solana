// Süreç giriş noktası: yapılandırma ve program kimlikleri doğrulanmadan servis açılmaz. Üç döngü: RPC
// taraması (backfill ve canlı), webhook kuyruğunun boşaltılması, zincir ↔ veritabanı uzlaştırması. Log,
// metrik, health ve alarmlar `@squaresdk/solana-observability`'dendir. Tek örnek çalışır: imleç ve yazma
// sırası tek yazıcı varsayar.
import type { Server } from 'node:http';
import { createDatabaseClient } from '@squaresdk/solana-db';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createLogger,
} from '@squaresdk/solana-observability';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { indexerAlarmRules } from './alarms.js';
import { createApp, createMetricsApp } from './app.js';
import { createChain } from './chain.js';
import { createCodec } from './codec.js';
import { loadConfig } from './config.js';
import { startLoop } from './loop.js';
import { createMetrics } from './metrics.js';
import { packageInfo } from './package-info.js';
import { createPipeline } from './pipeline.js';
import { createPoller } from './poller.js';
import { loadProgramIds } from './programs.js';
import { createReconciler } from './reconcile.js';
import { createWebhookQueue } from './webhook.js';

const MS_PER_SECOND = 1000;
/** Uzlaştırma log'una yazılan sapan adres sayısı. */
const DRIFT_SAMPLES = 20;

const listen = (app: { listen(port: number, callback: () => void): Server }, port: number) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = loadConfig(process.env);
  const log = createLogger({ service: packageInfo.name, level: config.observability.logLevel });
  const db = createDatabaseClient({ connectionString: config.databaseUrl });
  const programIds = await loadProgramIds(db);
  const chain = createChain({ ...config.rpc, onFailover: (event) => log.warn('rpc_failover', event) });
  const client = createSquareClient({ connection: chain.connection, programIds, commitment: 'finalized' });
  const codec = createCodec(client);
  const metrics = createMetrics({ service: packageInfo.name, version: packageInfo.version });
  const errors = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds });
  const pipeline = createPipeline({ db, chain, codec, metrics, log });
  const poller = createPoller({ db, chain, pipeline, programIds, pageSize: config.signaturePageSize, metrics, log });
  const reconciler = createReconciler({ db, chain, codec, pipeline, metrics, log, sampleSize: DRIFT_SAMPLES });
  const queue = config.webhook
    ? createWebhookQueue({
        chain,
        pipeline,
        maxPending: config.webhook.maxPending,
        pendingTtlSeconds: config.webhook.pendingTtlSeconds,
        metrics,
        log,
      })
    : null;
  const health = createHealth({
    version: packageInfo.version,
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      rpc: async () => {
        await chain.finalizedSlot();
      },
    },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: indexerAlarmRules({
      lastPollAt: () => poller.lastSuccessAt(),
      startedAt,
      lastDrift: () => reconciler.lastDrift(),
      errors,
      thresholds: config.alerts,
    }),
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
  });
  const app = createApp({
    health,
    metrics,
    log,
    webhook: config.webhook && queue ? { ...config.webhook, queue } : null,
  });

  const failed = (stage: string) => (error: unknown) => {
    errors.record();
    metrics.errors.inc({ stage });
    log.error(`${stage}_failed`, { error });
  };
  const stops = [
    startLoop({
      intervalMs: config.pollIntervalMs,
      immediate: true,
      run: () => poller.runOnce(),
      onError: failed('poll'),
    }),
    startLoop({
      intervalMs: config.reconcileIntervalSeconds * MS_PER_SECOND,
      immediate: false,
      // İlk tam tarama (backfill) bitmeden uzlaştırma, henüz işlenmemiş hesapları sapma sayardı.
      run: async () => (poller.lastSuccessAt() === null ? null : reconciler.run({ repair: true })),
      onError: failed('reconcile'),
    }),
    ...(queue
      ? [
          startLoop({
            intervalMs: config.pollIntervalMs,
            immediate: true,
            run: () => queue.drain(),
            onError: failed('webhook'),
          }),
        ]
      : []),
  ];
  const servers = await Promise.all([
    listen(app, config.port),
    listen(createMetricsApp(metrics.registry, log), config.metricsPort),
  ]);
  const stopAlarms = alarms.start(config.observability.alertEvaluationSeconds * MS_PER_SECOND);
  log.info('listening', {
    version: packageInfo.version,
    port: config.port,
    metricsPort: config.metricsPort,
    rpc: chain.endpoint(),
    webhook: queue !== null,
    programs: Object.fromEntries(Object.entries(programIds).map(([name, id]) => [name, id.toBase58()])),
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown', { signal });
    stopAlarms();
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(servers.map(close));
    await db.$disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  // Yapılandırma okunamadan düşen açılış: log düzeyi henüz bilinmediği için yalnızca hata yazılır.
  createLogger({ service: packageInfo.name, level: 'error' }).error('startup_failed', { error });
  process.exit(1);
});
