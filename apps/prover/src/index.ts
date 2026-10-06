// Süreç giriş noktası: yapılandırma ve artefaktlar doğrulanmadan servis açılmaz. Log, metrik, health ve
// alarmlar `@squaresdk/solana-observability`'dendir.
import type { Server } from 'node:http';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createLogger,
} from '@squaresdk/solana-observability';
import { proverAlarmRules } from './alarms.js';
import { createApp, createMetricsApp } from './app.js';
import { loadArtifacts } from './artifacts.js';
import { apiKeyCheck } from './auth.js';
import { loadConfig } from './config.js';
import { createLimiter } from './limiter.js';
import { createMetrics } from './metrics.js';
import { packageInfo } from './package-info.js';
import { createProver } from './prover.js';

const MS_PER_SECOND = 1000;

const listen = (app: { listen(port: number, callback: () => void): Server }, port: number) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ service: packageInfo.name, level: config.observability.logLevel });
  const artifacts = await loadArtifacts(config.artifacts);
  const prover = createProver(artifacts);
  const limiter = createLimiter(config.limits);
  const metrics = createMetrics({
    service: packageInfo.name,
    version: packageInfo.version,
    artifactVersion: artifacts.version,
    limiter,
  });
  const failures = createEventWindow({ windowSeconds: config.alerts.failureWindowSeconds });
  const health = createHealth({
    version: packageInfo.version,
    checks: { capacity: () => limiter.hasCapacity() },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: proverAlarmRules({ limiter, failures, thresholds: config.alerts }),
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
  });
  const app = createApp({
    info: packageInfo,
    corsOrigins: config.corsOrigins,
    checkApiKey: apiKeyCheck(config.apiKeySha256),
    prover,
    limiter,
    retryAfterSecs: Math.ceil(config.limits.queueTimeoutMs / MS_PER_SECOND),
    metrics,
    log,
    health,
    failures,
  });

  const servers = await Promise.all([
    listen(app, config.port),
    listen(createMetricsApp(metrics.registry, log), config.metricsPort),
  ]);
  const stopAlarms = alarms.start(config.observability.alertEvaluationSeconds * MS_PER_SECOND);
  log.info('listening', {
    version: packageInfo.version,
    circuit: artifacts.circuit,
    artifactVersion: artifacts.version,
    port: config.port,
    metricsPort: config.metricsPort,
    alertWebhook: config.observability.webhook !== null,
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown', { signal });
    stopAlarms();
    await Promise.all(servers.map(close));
    // snarkjs'in eğri worker'ları süreci açık tutar.
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
