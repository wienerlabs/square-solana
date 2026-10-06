// Süreç giriş noktası: yapılandırma, authority anahtarı, program kimlikleri ve zincirdeki `RegistryConfig`
// doğrulanmadan servis açılmaz: anahtar `screener_authority` değilse her tx `Unauthorized` ile düşerdi. Üç
// döngü: OFAC listesinin yenilenmesi, TTL yenileme ve authority bakiyesinin okunması. Log, metrik, health ve
// alarmlar `@squaresdk/solana-observability`'dendir. Tek örnek çalışır: eşzamanlı taramaların birleştirilmesi
// süreç içindedir (screener.ts).
import type { Server } from 'node:http';
import { createDatabaseClient } from '@squaresdk/solana-db';
import { createRateLimiter } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createLogger,
} from '@squaresdk/solana-observability';
import { createBalanceWatch, refreshOfacList, screenerAlarmRules } from './alarms.js';
import { createApp, createMetricsApp } from './app.js';
import { apiKeyCheck } from './auth.js';
import { createChain } from './chain.js';
import { loadConfig } from './config.js';
import { loadAuthorityKeypair } from './keypair.js';
import { startLoop } from './loop.js';
import { createMetrics } from './metrics.js';
import { packageInfo } from './package-info.js';
import { loadProgramIds } from './programs.js';
import { assertRenewalWindow, createRenewal } from './renewal.js';
import { createScreener } from './screener.js';
import { createChainalysisSource } from './sources/chainalysis.js';
import { createOfacSource } from './sources/ofac.js';
import type { ScreeningSource } from './sources/source.js';
import { createDecisionStore } from './store.js';

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
  const { keypair, warnings } = loadAuthorityKeypair(config.authority);
  for (const warning of warnings) log.warn('authority_keypair', { warning });
  const db = createDatabaseClient({ connectionString: config.databaseUrl });
  const programIds = await loadProgramIds(db);
  const chain = createChain({
    ...config.rpc,
    programIds,
    authority: keypair,
    computeUnitPrice: config.tx.computeUnitPrice,
    confirmPollMs: config.tx.confirmPollMs,
    onFailover: (event) => log.warn('rpc_failover', event),
  });
  const registryConfig = await chain.registryConfig();
  if (!registryConfig) throw new Error('RegistryConfig zincirde yok: registry init_registry_config ile başlatılmalı');
  if (!registryConfig.screenerAuthority.equals(chain.authority)) {
    throw new Error(
      `Anahtar screener authority değil: zincirde ${registryConfig.screenerAuthority.toBase58()}, ` +
        `servisin anahtarı ${chain.authority.toBase58()}`,
    );
  }
  assertRenewalWindow(config.renewal.marginSeconds, registryConfig.screeningTtlSecs);

  const metrics = createMetrics({ service: packageInfo.name, version: packageInfo.version });
  const errors = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds });
  const ofac = createOfacSource(config.ofac);
  const sources: ScreeningSource[] = [ofac];
  if (config.chainalysis) sources.push(createChainalysisSource(config.chainalysis));
  else log.warn('provider_disabled', { reason: 'SCREENER_CHAINALYSIS_API_KEY verilmedi; yalnızca OFAC SDN listesi' });
  const store = createDecisionStore(db);
  const screener = createScreener({ sources, chain, store, metrics, log, errors });
  const renewal = createRenewal({
    store,
    screener,
    marginSeconds: config.renewal.marginSeconds,
    retrySeconds: config.renewal.retrySeconds,
    batch: config.renewal.batch,
    metrics,
    log,
  });
  const balance = createBalanceWatch(chain, metrics);
  const health = createHealth({
    version: packageInfo.version,
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      // RPC'ye ulaşılıyor ve anahtar hâlâ screener authority (config döndürülmüş olabilir).
      registry: async () => (await chain.registryConfig())?.screenerAuthority.equals(chain.authority) === true,
      ofac: () => ofac.fresh(),
    },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: screenerAlarmRules({
      errors,
      balance: balance.value,
      ofac,
      ofacMaxAgeSeconds: config.ofac.maxAgeSeconds,
      startedAt,
      thresholds: config.alerts,
    }),
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
  });
  const rateStore = createPrismaRateLimitStore(db);
  const window = (limit: number) =>
    createRateLimiter({ store: rateStore, rule: { limit, windowSeconds: config.rateLimit.windowSeconds } });
  const app = createApp({
    info: packageInfo,
    screener,
    store,
    checkApiKey: apiKeyCheck(config.apiKeySha256),
    limiters: { screen: window(config.rateLimit.screen), read: window(config.rateLimit.read) },
    health,
    metrics,
    log,
    jsonMaxBytes: config.jsonMaxBytes,
  });

  const failed = (stage: string) => (error: unknown) => {
    errors.record();
    metrics.errors.inc({ stage });
    log.error(`${stage}_failed`, { error });
  };
  const stops = [
    startLoop({
      intervalMs: config.ofac.refreshSeconds * MS_PER_SECOND,
      immediate: true,
      run: () => refreshOfacList({ ofac, metrics, log }),
      onError: failed('ofac_refresh'),
    }),
    startLoop({
      intervalMs: config.renewal.intervalSeconds * MS_PER_SECOND,
      immediate: true,
      // Liste yokken ya da bayatken her aday kaynak hatası olurdu; liste gelince yenileme başlar.
      run: async () => (ofac.fresh() ? renewal.runOnce() : null),
      onError: failed('renewal'),
    }),
    startLoop({
      intervalMs: config.renewal.intervalSeconds * MS_PER_SECOND,
      immediate: true,
      run: () => balance.refresh(),
      onError: failed('balance'),
    }),
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
    authority: chain.authority.toBase58(),
    screeningTtlSecs: registryConfig.screeningTtlSecs,
    sources: sources.map((source) => source.name),
    registry: programIds.registry.toBase58(),
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
