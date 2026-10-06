// Süreç giriş noktası: yapılandırma ve program kimlikleri doğrulanmadan servis açılmaz. Log, metrik, health ve
// alarmlar `@squaresdk/solana-observability`'dendir. Sponsor anahtarı yalnızca ortamdan okunur ve log'a yazılmaz.
import type { Server } from 'node:http';
import { createDatabaseClient } from '@squaresdk/solana-db';
import { createFailoverFetch } from '@squaresdk/solana-hardening';
import { createLogger } from '@squaresdk/solana-observability';
import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { packageInfo } from './package-info.js';
import { loadProgramIds } from './programs.js';
import { createFeePayerService } from './service.js';

const MS_PER_SECOND = 1000;

const listen = (app: { listen(port: number, callback: () => void): Server }, port: number) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
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
  const service = createFeePayerService({ config, db, connection, programIds, log });
  const servers = await Promise.all([listen(service.app, config.port), listen(service.metricsApp, config.metricsPort)]);
  const stopAlarms = service.alarms.start(config.observability.alertEvaluationSeconds * MS_PER_SECOND);
  log.info('listening', {
    version: packageInfo.version,
    port: config.port,
    metricsPort: config.metricsPort,
    sponsor: config.sponsor.publicKey.toBase58(),
    balanceLamports: await service.sponsor.balance(),
    rpc: fetch.endpoint(),
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown', { signal });
    stopAlarms();
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
