import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import type { PrismaClient } from '@squaresdk/solana-db';
import { runPrisma, startIsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createRemoteProver, type Prover } from '@squaresdk/solana-policy';
import { createApiClient, type SquareApi } from '@squaresdk/solana-sdk';
import { stderr } from '@squaresdk/solana-smoke/cli';
import { loadClusterConfig } from '@squaresdk/solana-smoke/config';
import { createContext, type Context } from '@squaresdk/solana-smoke/context';
import { runInit } from '@squaresdk/solana-smoke/init';
import { loadRoleKeys } from '@squaresdk/solana-smoke/keys';
import {
  LOCALNET_AIRDROPS,
  assertDeployedPrograms,
  fundLocalnet,
  localnetProgramIds,
  startValidator,
  writeRoleKeys,
  type LocalnetKeys,
} from '@squaresdk/solana-smoke/localnet';
import { loadCircuitArtifacts, localProver, releaseProverWorkers } from '@squaresdk/solana-smoke/prover';
import type { KeeperAction } from '@squaresdk/solana-types';
import { createScopedApiKey, type ApiAuth } from './auth.js';
import {
  SERVICE_NAMES,
  apiEnv,
  indexerEnv,
  keeperEnv,
  proverEnv,
  screenerEnv,
  type HttpPorts,
  type ServiceEnv,
  type ServiceName,
} from './env.js';
import { REPO_ROOT, type WorldOptions } from './options.js';
import { allocatePorts, logTail, startService, waitReady, type ServiceProcess } from './processes.js';
import { sdnXml } from './sdn.js';
import { startObjectStore } from './storage.js';
import { selfSignedCertificate, serveOverHttps } from './tls.js';
import { until } from './wait.js';

export const PIPELINE_ONLY_RECONCILE_SECONDS = 86_400;
const READY_TIMEOUT_MS = 180_000;
const KEEPER_TIMEOUT_MS = 240_000;
const SCREENER_TIMEOUT_MS = 120_000;

export interface ScreeningDecision {
  readonly id: string;
  readonly wallet: string;
  readonly trigger: 'request' | 'renewal';
  readonly outcome: 'recorded' | 'sourceError' | 'txFailed';
  readonly status: 'clear' | 'flagged' | null;
  readonly signature: string | null;
  readonly expiresAt: number | null;
}

interface ScreenerEnvelope<T> {
  readonly success: boolean;
  readonly data: T | null;
  readonly error: { code: string; message: string } | null;
}

export interface World {
  readonly context: Context;
  readonly key: LocalnetKeys;
  readonly flagged: Keypair;
  readonly programs: readonly PublicKey[];
  readonly db: PrismaClient;
  readonly logDir: string;
  readonly provers: { readonly local: Prover; readonly remote: Prover };
  service(name: ServiceName): ServiceProcess;
  api(auth?: ApiAuth): SquareApi;
  screen(wallet: PublicKey): Promise<ScreeningDecision>;
  screeningHistory(wallet: PublicKey): Promise<ScreeningDecision[]>;
  keeperActions(job: PublicKey): Promise<KeeperAction[]>;
  waitForKeeper(job: PublicKey, reason?: string): Promise<KeeperAction>;
  restartIndexer(reconcileIntervalSeconds: number): Promise<ServiceProcess>;
  logTails(): string;
  close(options: { keepLogs: boolean }): Promise<void>;
}

type Cleanup = () => Promise<void>;

function tracked<T>(cleanup: Cleanup[], settled: PromiseSettledResult<T>, stop: (value: T) => Promise<void>): T | null {
  if (settled.status === 'rejected') return null;
  const { value } = settled;
  cleanup.push(() => stop(value));
  return value;
}

async function runCleanup(cleanup: Cleanup[]): Promise<void> {
  for (const step of cleanup.splice(0).reverse()) {
    try {
      await step();
    } catch (error) {
      stderr(`kapatma adımı başarısız: ${(error as Error).message}`);
    }
  }
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export async function startWorld(options: WorldOptions): Promise<World> {
  const cleanup: Cleanup[] = [];
  const workDir = mkdtempSync(join(tmpdir(), 'square-services-'));
  cleanup.push(async () => rmSync(workDir, { recursive: true, force: true }));
  const logDir = options.logDir ?? mkdtempSync(join(tmpdir(), 'square-services-logs-'));
  mkdirSync(logDir, { recursive: true });
  stderr(`servisler: günlükler ${logDir}`);
  try {
    const artifacts = loadCircuitArtifacts();
    const programIds = localnetProgramIds(readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8'));
    const key = writeRoleKeys(workDir);
    const flagged = Keypair.generate();

    const [databaseResult, storeResult, validatorResult] = await Promise.allSettled([
      startIsolatedDatabase(),
      startObjectStore(),
      startValidator({
        args: {
          deployDir: options.deployDir,
          ledger: options.ledger ?? join(workDir, 'ledger'),
          rpcPort: options.rpcPort,
          faucetPort: options.faucetPort,
          gossipPort: options.gossipPort,
          dynamicPortRange: options.dynamicPortRange,
        },
        programIds,
        upgradeAuthority: key.admin.publicKey,
        logPath: join(logDir, 'validator.log'),
      }),
    ]);
    const database = tracked(cleanup, databaseResult, (value) => value.stop());
    const store = tracked(cleanup, storeResult, (value) => value.stop());
    const validator = tracked(cleanup, validatorResult, (value) => value.stop());
    for (const result of [databaseResult, storeResult, validatorResult]) {
      if (result.status === 'rejected') throw result.reason;
    }
    if (!database || !store || !validator) throw new Error('altyapı açılamadı');
    const { connection, rpcUrl } = validator;
    stderr(`localnet: Agave ${validator.agave} · ${rpcUrl} · Postgres ve S3 uyumlu depo açık`);

    const clusterConfig = await fundLocalnet({
      connection,
      rpcUrl,
      programIds,
      key,
      airdrops: [...LOCALNET_AIRDROPS, ['screener', 10]],
    });
    const configPath = join(workDir, 'localnet.json');
    writeFileSync(configPath, JSON.stringify(clusterConfig, null, 2));
    const loaded = loadClusterConfig(configPath, {});
    const keys = loadRoleKeys(loaded);
    stderr('init:');
    const init = await runInit(createContext(loaded, keys, stderr));
    assertDeployedPrograms(init.record, options.deployDir);
    const context = createContext({ ...loaded, lookupTable: init.lookupTable ?? undefined }, keys, stderr);

    await runPrisma(['db', 'seed'], database.url, {
      SQUARE_PROGRAM_ID_REGISTRY: programIds.registry,
      SQUARE_PROGRAM_ID_POLICY: programIds.policy,
      SQUARE_PROGRAM_ID_VERIFIER: programIds.verifier,
      SQUARE_PROGRAM_ID_ESCROW: programIds.escrow,
    });

    const certificate = await selfSignedCertificate(workDir);
    const sdn = await serveOverHttps({
      certificate,
      path: '/SDN.XML',
      body: sdnXml(
        [{ uid: 990_001, name: 'SQUARE SERVICES E2E FLAGGED PARTY', solanaAddress: flagged.publicKey.toBase58() }],
        new Date(),
      ),
      contentType: 'application/xml',
    });
    cleanup.push(() => sdn.close());

    const proverServiceKey = randomBytes(32).toString('base64url');
    const screenerApiKey = randomBytes(32).toString('base64url');
    const circuitDir = join(REPO_ROOT, 'circuits/payment-compliance');
    const [proverPorts, indexerPorts, keeperPorts, screenerPorts, apiPorts] = await allocatePorts(SERVICE_NAMES.length);
    const databaseUrl = database.url;
    const indexerFor = (ports: HttpPorts, reconcileIntervalSeconds: number) =>
      indexerEnv({ databaseUrl, rpcUrl, ports, reconcileIntervalSeconds });
    const plan: Record<ServiceName, { ports: HttpPorts; env: ServiceEnv }> = {
      prover: {
        ports: proverPorts!,
        env: proverEnv({
          ports: proverPorts!,
          apiKeySha256: sha256Hex(proverServiceKey),
          artifacts: {
            manifest: join(circuitDir, 'artifacts/manifest.json'),
            wasm: join(circuitDir, 'build/payment_js/payment.wasm'),
            zkey: join(circuitDir, 'artifacts/payment.zkey'),
          },
        }),
      },
      indexer: { ports: indexerPorts!, env: indexerFor(indexerPorts!, PIPELINE_ONLY_RECONCILE_SECONDS) },
      keeper: {
        ports: keeperPorts!,
        env: keeperEnv({ databaseUrl, rpcUrl, ports: keeperPorts!, secretKey: key.keeper.secretKey }),
      },
      screener: {
        ports: screenerPorts!,
        env: screenerEnv({
          databaseUrl,
          rpcUrl,
          ports: screenerPorts!,
          apiKeySha256: sha256Hex(screenerApiKey),
          authorityKeyPath: join(workDir, 'screener.json'),
          ofacUrl: sdn.url,
          caCertPath: certificate.certPath,
        }),
      },
      api: {
        ports: apiPorts!,
        env: apiEnv({
          databaseUrl,
          rpcUrl,
          ports: apiPorts!,
          store,
          prover: { url: `http://127.0.0.1:${proverPorts!.port}`, apiKey: proverServiceKey },
          lookupTable: init.lookupTable?.toBase58() ?? null,
          keyRings: { travelRule: randomBytes(32).toString('base64'), webhook: randomBytes(32).toString('base64') },
        }),
      },
    };
    const launch = (name: ServiceName, logName: string, ports: HttpPorts, env: ServiceEnv) =>
      startService({
        name: logName,
        command: process.execPath,
        args: [join(REPO_ROOT, `apps/${name}/dist/index.js`)],
        env,
        ports,
        logDir,
      });
    const running = new Map<ServiceName, ServiceProcess>();
    cleanup.push(async () => {
      await Promise.all([...running.values()].map((service) => service.stop()));
    });
    for (const name of SERVICE_NAMES) running.set(name, launch(name, name, plan[name].ports, plan[name].env));
    await Promise.all([...running.values()].map((service) => waitReady(service, READY_TIMEOUT_MS)));
    const service = (name: ServiceName) => running.get(name)!;
    stderr(`servisler hazır: ${SERVICE_NAMES.map((name) => `${name} ${service(name).url}`).join(', ')}`);

    const api = (auth?: ApiAuth) => createApiClient({ baseUrl: service('api').url, ...(auth ? { auth } : {}) });
    const proveKey = await createScopedApiKey(api, key.institution, ['prove'], 'services-e2e');
    cleanup.push(() => releaseProverWorkers());
    const provers = {
      local: localProver(artifacts),
      remote: createRemoteProver({ baseUrl: service('api').url, apiKey: proveKey, artifactVersion: artifacts.version }),
    };

    async function screener<T>(path: string, init: RequestInit): Promise<T> {
      const response = await fetch(`${service('screener').url}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-api-key': screenerApiKey },
        signal: AbortSignal.timeout(SCREENER_TIMEOUT_MS),
      });
      const body = (await response.json()) as ScreenerEnvelope<T>;
      if (!body.success || body.data === null) {
        throw new Error(`screener ${path}: HTTP ${response.status} ${body.error?.code} ${body.error?.message}`);
      }
      return body.data;
    }

    async function keeperActions(job: PublicKey): Promise<KeeperAction[]> {
      const result = await api().listKeeperActions({ job: job.toBase58(), limit: 200 });
      if (!result.success) throw new Error(`keeper günlüğü: ${result.error.code} ${result.error.message}`);
      return result.data;
    }

    return {
      context,
      key,
      flagged,
      programs: Object.values(context.config.programIds),
      db: database.client,
      logDir,
      provers,
      service,
      api,
      async screen(wallet) {
        const decision = await screener<ScreeningDecision>('/v1/screenings', {
          method: 'POST',
          body: JSON.stringify({ wallet: wallet.toBase58() }),
        });
        if (decision.outcome !== 'recorded') {
          throw new Error(`screener ${wallet.toBase58()}: ${decision.outcome}`);
        }
        return decision;
      },
      screeningHistory: (wallet) =>
        screener<ScreeningDecision[]>(`/v1/screenings/${wallet.toBase58()}/history?limit=50`, { method: 'GET' }),
      keeperActions,
      waitForKeeper(job, reason) {
        const wanted = (action: KeeperAction) =>
          action.action === 'finalizePayment' &&
          (reason === undefined ? action.outcome === 'confirmed' : action.reason === reason);
        return until(
          `keeper ${reason ?? 'finalize onayı'}: ${job.toBase58()}`,
          KEEPER_TIMEOUT_MS,
          async () => (await keeperActions(job)).find(wanted),
          {
            describe: async () =>
              `keeper günlüğü: ${JSON.stringify(await keeperActions(job))}\n${logTail(service('keeper').logPath)}`,
          },
        );
      },
      async restartIndexer(reconcileIntervalSeconds) {
        await service('indexer').stop();
        const [ports] = await allocatePorts(1);
        const restarted = launch('indexer', 'indexer-restart', ports!, indexerFor(ports!, reconcileIntervalSeconds));
        running.set('indexer', restarted);
        await waitReady(restarted, READY_TIMEOUT_MS);
        return restarted;
      },
      logTails: () =>
        readdirSync(logDir)
          .filter((file) => file.endsWith('.log'))
          .map((file) => `--- ${file}\n${logTail(join(logDir, file), 40)}`)
          .join('\n'),
      async close({ keepLogs }) {
        await runCleanup(cleanup);
        if (keepLogs || options.logDir) stderr(`servisler: günlükler ${logDir}`);
        else rmSync(logDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runCleanup(cleanup);
    stderr(`servisler açılamadı; günlükler ${logDir}`);
    throw error;
  }
}
