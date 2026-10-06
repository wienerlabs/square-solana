// Süreç giriş noktası: yapılandırma, program kimlikleri, ağ referansı ve OpenAPI belgesi doğrulanmadan servis
// açılmaz. Log, metrik, health ve alarmlar `@squaresdk/solana-observability`'dendir.
import type { Server } from 'node:http';
import { createDatabaseClient } from '@squaresdk/solana-db';
import { createFailoverFetch, createRateLimiter, createSafeFetch, createSecretBox } from '@squaresdk/solana-hardening';
import { createPrismaRateLimitStore } from '@squaresdk/solana-hardening/prisma';
import { createReadApi } from '@squaresdk/solana-indexer/read';
import {
  alarmNotifiers,
  createAlarms,
  createEventWindow,
  createHealth,
  createLogger,
  createServiceMetrics,
} from '@squaresdk/solana-observability';
import { createTransferStore } from '@squaresdk/solana-cctp';
import { createSquareClient } from '@squaresdk/solana-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import { createApp, createMetricsApp } from './app.js';
import { createAuthService } from './auth/service.js';
import { createCallerAuthority } from './caller.js';
import { createCardService } from './cards.js';
import { loadConfig } from './config.js';
import { createDeliveryService } from './deliveries.js';
import { createArbitrationService } from './disputes/arbitration.js';
import { createArbitrators } from './disputes/arbitrators.js';
import { createEvidenceService } from './disputes/evidence.js';
import { createNotifier, createNotifierMetrics } from './disputes/notifier.js';
import { createParties } from './disputes/parties.js';
import { createWebhookService } from './disputes/webhooks.js';
import { createInstitutionAuthority } from './institution-authority.js';
import { startLoop } from './loop.js';
import { loadOpenApi } from './openapi.js';
import { packageInfo } from './package-info.js';
import { createPolicyMetaService } from './policy-meta.js';
import { loadProgramIds } from './programs.js';
import { createProverProxy } from './prover.js';
import { createDeliveryStore, createEvidenceStore } from './storage.js';
import { startTravelRuleMaintenance } from './travel-rule/maintenance.js';
import { createTravelRuleService } from './travel-rule/service.js';
import { createTxBuilder } from './tx.js';
import { createCctpService } from './cctp.js';
import { createX402EndpointService } from './x402.js';

const MS_PER_SECOND = 1000;
/** did:aip v2 Solana ağ referansı: genesis hash'inin ilk 32 karakteri (CAIP-2). */
const CHAIN_REF_LENGTH = 32;
/** Webhook yanıtının okunan en büyük boyutu; gövde kullanılmaz, yalnızca durum kodu. */
const NOTIFY_RESPONSE_MAX_BYTES = 64 * 1024;

const listen = (app: { listen(port: number, callback: () => void): Server }, port: number) =>
  new Promise<Server>((resolve) => {
    const server = app.listen(port, () => resolve(server));
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger({ service: packageInfo.name, level: config.observability.logLevel });
  const openapi = loadOpenApi(new URL('./openapi.json', import.meta.url), config.publicBaseUrl);
  const db = createDatabaseClient({ connectionString: config.databaseUrl });
  const programIds = await loadProgramIds(db);
  const fetch = createFailoverFetch({
    endpoints: config.rpc.urls,
    timeoutMs: config.rpc.timeoutMs,
    cooldownMs: config.rpc.cooldownMs,
    onFailover: (event) => log.warn('rpc_failover', event),
  });
  const connection = new Connection(config.rpc.urls[0]!, { commitment: 'confirmed', fetch });
  const chainRef = (await connection.getGenesisHash()).slice(0, CHAIN_REF_LENGTH);
  const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
  const store = createDeliveryStore(config.deliveries.store);
  const authority = createInstitutionAuthority({ db, connection });
  const callers = createCallerAuthority({ connection });
  const travelRule = createTravelRuleService({
    db,
    client,
    authority,
    box: createSecretBox({ keys: config.travelRule.keys, activeKeyId: config.travelRule.activeKeyId }),
    retentionSeconds: config.travelRule.retentionSeconds,
  });
  const evidenceStore = createEvidenceStore({ ...config.deliveries.store, bucket: config.evidence.bucket });
  const read = createReadApi({ db, chainRef, registryProgramId: programIds.registry });
  const tx = createTxBuilder({
    client,
    connection,
    lookupTable: config.tx.lookupTable ? new PublicKey(config.tx.lookupTable) : null,
    computeUnitPrice: config.tx.computeUnitPrice,
  });
  const box = createSecretBox({
    keys: config.webhookSecrets.keys,
    activeKeyId: config.webhookSecrets.activeKeyId,
  });
  const arbitrators = createArbitrators({ client, ttlMs: config.arbitratorCacheSeconds * MS_PER_SECOND });
  const evidence = createEvidenceService({
    db,
    store: evidenceStore,
    parties: createParties({ db, connection, arbitrators }),
  });
  const urlPolicy = {
    allowHttp: config.notify.allowInsecure,
    allowPrivateAddresses: config.notify.allowInsecure,
  };
  const rateStore = createPrismaRateLimitStore(db);
  const window = (limit: number) =>
    createRateLimiter({ store: rateStore, rule: { limit, windowSeconds: config.rateLimit.windowSeconds } });
  const metrics = createServiceMetrics({ service: packageInfo.name, version: packageInfo.version });
  const errors = createEventWindow({ windowSeconds: config.alerts.errorWindowSeconds });
  const health = createHealth({
    version: packageInfo.version,
    checks: {
      database: async () => {
        await db.$queryRaw`SELECT 1`;
      },
      rpc: async () => {
        await connection.getSlot();
      },
      storage: async () => {
        await Promise.all([store.check(), evidenceStore.check()]);
      },
    },
    timeoutMs: config.observability.healthCheckTimeoutMs,
    logger: log,
  });
  const alarms = createAlarms({
    service: packageInfo.name,
    rules: [
      {
        name: 'api_errors',
        description: `Son ${config.alerts.errorWindowSeconds} saniyede iç ve bağımlılık hataları eşiğin üstünde`,
        severity: 'critical',
        read: () => errors.count(),
        above: config.alerts.errors,
        forSeconds: 0,
      },
    ],
    notifiers: alarmNotifiers(config.observability),
    logger: log,
    registry: metrics.registry,
  });
  const cctp = createCctpService({
    store: createTransferStore(db),
    env: config.cctp && {
      client,
      connection,
      programs: config.cctp.programs,
      cctpLookupTables: config.cctp.lookupTables,
      squareLookupTable: config.tx.lookupTable ? new PublicKey(config.tx.lookupTable) : null,
    },
    tx,
    computeUnitPrice: config.tx.computeUnitPrice,
  });
  const app = createApp({
    db,
    read,
    auth: createAuthService({
      db,
      domain: config.auth.domain,
      challengeTtlSeconds: config.auth.challengeTtlSeconds,
      sessionTtlSeconds: config.auth.sessionTtlSeconds,
    }),
    deliveries: createDeliveryService({ db, store, callers }),
    cards: createCardService({
      db,
      pda: client.pda,
      registryProgramId: programIds.registry,
      chainRef,
      publicBaseUrl: config.publicBaseUrl,
      callers,
    }),
    policyMeta: createPolicyMetaService({ db, authority }),
    tx,
    evidence,
    arbitration: createArbitrationService({ db, read, client, tx, arbitrators, evidence }),
    webhooks: createWebhookService({ db, box, arbitrators, urlPolicy }),
    evidenceMaxBytes: config.evidence.maxBytes,
    prover: createProverProxy(config.prover),
    x402: createX402EndpointService({ db }),
    travelRule,
    cctp,
    limiters: { read: window(config.rateLimit.read), write: window(config.rateLimit.write) },
    openapi,
    health,
    metrics,
    log,
    errors,
    corsOrigins: config.corsOrigins,
    trustProxyHops: config.trustProxyHops,
    jsonMaxBytes: config.jsonMaxBytes,
    deliveryMaxBytes: config.deliveries.maxBytes,
  });

  const servers = await Promise.all([
    listen(app, config.port),
    listen(createMetricsApp(metrics.registry, log), config.metricsPort),
  ]);
  const stopAlarms = alarms.start(config.observability.alertEvaluationSeconds * MS_PER_SECOND);
  const stopMaintenance = startTravelRuleMaintenance({
    run: () => travelRule.maintain(),
    intervalMs: config.travelRule.maintenanceIntervalSeconds * MS_PER_SECOND,
    log,
    onError: () => errors.record(),
  });
  const safeFetch = createSafeFetch({
    ...urlPolicy,
    timeoutMs: config.notify.timeoutMs,
    maxBytes: NOTIFY_RESPONSE_MAX_BYTES,
    maxRedirects: 0,
  });
  const notifier = createNotifier({
    db,
    box,
    arbitrators,
    send: async (url, init) => ({ status: (await safeFetch(url, init)).status }),
    batchSize: config.notify.batchSize,
    maxAttempts: config.notify.maxAttempts,
    backoff: config.notify.backoff,
    deadlineWarningSeconds: config.notify.deadlineWarningSeconds,
    leaseSeconds: Math.ceil((config.notify.timeoutMs * 2) / MS_PER_SECOND) + 1,
    metrics: createNotifierMetrics(metrics.registry),
    log,
  });
  const stopNotifier = startLoop({
    intervalMs: config.notify.intervalMs,
    immediate: true,
    run: () => notifier.runOnce(),
    onError: (error) => {
      errors.record();
      log.error('notifier_failed', { error });
    },
  });
  log.info('listening', {
    version: packageInfo.version,
    contractVersion: openapi.info.version,
    port: config.port,
    metricsPort: config.metricsPort,
    chainRef,
    rpc: fetch.endpoint(),
  });

  const shutdown = async (signal: string) => {
    log.info('shutdown', { signal });
    stopAlarms();
    await stopMaintenance();
    await stopNotifier();
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
