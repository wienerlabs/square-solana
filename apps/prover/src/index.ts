// Süreç giriş noktası: yapılandırma ve artefaktlar doğrulanmadan servis açılmaz.
import type { Server } from 'node:http';
import { createApp, createMetricsApp } from './app.js';
import { loadArtifacts } from './artifacts.js';
import { apiKeyCheck } from './auth.js';
import { loadConfig } from './config.js';
import { errorSummary } from './errors.js';
import { createLimiter } from './limiter.js';
import { processLog } from './log.js';
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
  const artifacts = await loadArtifacts(config.artifacts);
  const prover = createProver(artifacts);
  const limiter = createLimiter(config.limits);
  const metrics = createMetrics({
    service: packageInfo.name,
    version: packageInfo.version,
    artifactVersion: artifacts.version,
    limiter,
  });
  const app = createApp({
    info: packageInfo,
    corsOrigins: config.corsOrigins,
    checkApiKey: apiKeyCheck(config.apiKeySha256),
    prover,
    limiter,
    retryAfterSecs: Math.ceil(config.limits.queueTimeoutMs / MS_PER_SECOND),
    metrics,
    log: processLog,
  });

  const servers = await Promise.all([
    listen(app, config.port),
    listen(createMetricsApp(metrics.registry, processLog), config.metricsPort),
  ]);
  processLog.event('listening', {
    service: packageInfo.name,
    version: packageInfo.version,
    circuit: artifacts.circuit,
    artifactVersion: artifacts.version,
    port: config.port,
    metricsPort: config.metricsPort,
  });

  const shutdown = async (signal: string) => {
    processLog.event('shutdown', { signal });
    await Promise.all(servers.map(close));
    // snarkjs'in eğri worker'ları süreci açık tutar.
    process.exit(0);
  };
  process.once('SIGTERM', (signal) => void shutdown(signal));
  process.once('SIGINT', (signal) => void shutdown(signal));
}

main().catch((error: unknown) => {
  processLog.error('startup_failed', { error: errorSummary(error) });
  process.exit(1);
});
