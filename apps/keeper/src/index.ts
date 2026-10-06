// Süreç giriş noktası: yapılandırma ve program kimlikleri doğrulanmadan servis açılmaz. Döngüler: finalize
// crank'i (BE-15), lapse crank'i (BE-22) ve yapılandırılmışsa CCTP relayer'ı (BE-26). Tek örnek çalışır: aynı job'a iki keeper aynı anda tx göndermesin. Log, metrik, health ve alarmlar
// `@squaresdk/solana-observability`'dendir.
import type { Server } from 'node:http';
import { createDatabaseClient } from '@squaresdk/solana-db';
import { createFailoverFetch } from '@squaresdk/solana-hardening';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createLogger,
} from '@squaresdk/solana-observability';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Connection } from '@solana/web3.js';
import { keeperAlarmRules } from './alarms.js';
import { createApp, createMetricsApp } from './app.js';
import { createCctpRound } from './cctp.js';
import { loadConfig } from './config.js';
import { createCrank } from './crank.js';
import { createJournal, createLapseJournal } from './journal.js';
import { createLapseCrank } from './lapse.js';
import { startLoop } from './loop.js';
import { createMetrics } from './metrics.js';
import { packageInfo } from './package-info.js';
import { loadProgramIds } from './programs.js';
import { createStateReader } from './state.js';

const MS_PER_SECOND = 1000;

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
  const fetch = createFailoverFetch({
    endpoints: config.rpc.urls,
    timeoutMs: config.rpc.timeoutMs,
    cooldownMs: config.rpc.cooldownMs,
    onFailover: (event) => log.warn('rpc_failover', event),
  });
  const connection = new Connection(config.rpc.urls[0]!, { commitment: 'confirmed', fetch });
  const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
  const metrics = createMetrics({ service: packageInfo.name, version: packageInfo.version });
  const errors = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds });
  const crank = createCrank({
    client,
    connection,
    reader: createStateReader({ client, connection }),
    journal: createJournal(db),
    keeper: config.keeper,
    economics: config.economics,
    backoff: config.backoff,
    batchSize: config.batchSize,
    confirmPollMs: config.confirmPollMs,
    metrics,
    log,
    onError: () => errors.record(),
  });
  const lapse = createLapseCrank({
    client,
    connection,
    journal: createLapseJournal(db),
    keeper: config.keeper,
    fees: config.economics,
    backoff: config.backoff,
    batchSize: config.batchSize,
    confirmPollMs: config.confirmPollMs,
    metrics,
    log,
    onError: () => errors.record(),
  });
  const health = createHealth({
    version: packageInfo.version,
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      rpc: async () => {
        await connection.getSlot();
      },
    },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: keeperAlarmRules({
      // İki crank'ten geride olanı: biri durursa alarm çalar.
      lastRoundAt: () => {
        const rounds = [crank.lastSuccessAt(), lapse.lastSuccessAt()];
        return rounds.includes(null) ? null : Math.min(...(rounds as number[]));
      },
      lastBalance: () => crank.lastBalance(),
      oldestDueSeconds: () => crank.oldestDueSeconds(),
      startedAt,
      errors,
      thresholds: config.alerts,
    }),
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
  });
  const failed = (stage: string) => (error: unknown) => {
    errors.record();
    log.error(`${stage}_failed`, { error });
  };
  const stops = [
    startLoop({
      intervalMs: config.pollIntervalMs,
      immediate: true,
      run: () => crank.runOnce(),
      onError: failed('round'),
    }),
    startLoop({
      intervalMs: config.pollIntervalMs,
      immediate: true,
      run: () => lapse.runOnce(),
      onError: failed('lapse_round'),
    }),
  ];
  const cctp =
    config.cctp &&
    createCctpRound({
      db,
      client,
      connection,
      keeper: config.keeper,
      config: config.cctp,
      economics: config.economics,
      batchSize: config.batchSize,
      confirmPollMs: config.confirmPollMs,
      metrics,
      log,
      onError: () => errors.record(),
    });
  if (cctp) {
    stops.push(
      startLoop({
        intervalMs: config.pollIntervalMs,
        immediate: true,
        run: () => cctp.runOnce(),
        onError: failed('cctp_round'),
      }),
    );
  }
  const servers = await Promise.all([
    listen(createApp({ health }), config.port),
    listen(createMetricsApp(metrics.registry, log), config.metricsPort),
  ]);
  const stopAlarms = alarms.start(config.observability.alertEvaluationSeconds * MS_PER_SECOND);
  log.info('listening', {
    version: packageInfo.version,
    port: config.port,
    metricsPort: config.metricsPort,
    keeper: config.keeper.publicKey.toBase58(),
    rpc: fetch.endpoint(),
    cctp: config.cctp ? [...config.cctp.settings.lookupTables.keys()] : null,
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
