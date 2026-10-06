// Çalıştırıcı: yapılandırma dosyasından hosted agent'ın bağımlılıklarını kurar (keypair'ler, RPC bağlantısı, Postgres
// görev deposu, Claude istemcisi, delegasyon defteri, politika salt'ları ve uzak prover) ve agent'ı başlatır.
// `square-hosted` (bin.ts) bunun ince bir sarmalayıcısıdır. Anahtarlar ve sırlar yalnızca dosyadan ya da ortamdan
// okunur, log'a yazılmaz.
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import type { TaskStore } from '@squaresdk/solana-a2a';
import type { AgentLogger } from '@squaresdk/solana-agent-sdk';
import { createRemoteProver, derivePolicySalts, type Prover, type PolicySalts } from '@squaresdk/solana-policy';
import type { MessagesClient } from './claude.js';
import {
  HostedConfigError,
  assertEnv,
  envRequired,
  loadHostedConfig,
  type HostedConfig,
  type LoadedConfig,
} from './config.js';
import type { UnsignedDelegationTx } from './delegation.js';
import { createHostedAgent, type HostedAgent, type HostedDeps } from './hosted.js';
import { createFileLedger, createMemoryLedger } from './ledger.js';
import { readKeypairFile, type InstitutionSigner } from './signer.js';

export const USAGE = `kullanım: square-hosted --config <dosya.yaml|dosya.json> [--check]
  --config   hosted agent yapılandırması (packages/hosted/README.md)
  --check    yapılandırmayı, politika belgesini, anahtar dosyalarını ve ortamı doğrular; agent başlatılmaz`;

export interface RunnerArgs {
  config: string;
  check: boolean;
}

export function parseArgs(argv: readonly string[]): RunnerArgs | 'help' {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  let config: string | null = null;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') check = true;
    else if (arg === '--config') {
      config = argv[++i] ?? null;
      if (!config) throw new HostedConfigError(`--config bir dosya yolu ister\n${USAGE}`);
    } else if (arg.startsWith('--config=')) config = arg.slice('--config='.length);
    else throw new HostedConfigError(`bilinmeyen argüman: ${arg}\n${USAGE}`);
  }
  if (!config) throw new HostedConfigError(`--config zorunlu\n${USAGE}`);
  return { config, check };
}

/** 32 baytlık politika sırrı: dosyada 64 hex karakter. */
export async function readPolicySecret(path: string): Promise<Uint8Array> {
  let text: string;
  try {
    text = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    throw new HostedConfigError(`politika sırrı okunamadı: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new HostedConfigError(`politika sırrı 64 hex karakter olmalı: ${path}`);
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

async function institutionSigner(config: HostedConfig): Promise<InstitutionSigner | undefined> {
  const signer = config.signers.institution;
  if (!signer) return undefined;
  if (signer.type === 'unsigned') return { type: 'unsigned', publicKey: new PublicKey(signer.publicKey) };
  const keypair = await readKeypairFile(signer.keypairPath);
  return { type: 'keypair', publicKey: keypair.publicKey, keypair };
}

/** İmzasız kipte dışa verilen tx'i outbox dizinine `<job>-<adım>.json` olarak yazar (0600). */
export function writeUnsignedTx(outboxDir: string, tx: UnsignedDelegationTx): string {
  mkdirSync(outboxDir, { recursive: true });
  const path = join(outboxDir, `${tx.job}-${tx.step}.json`);
  writeFileSync(path, `${JSON.stringify(tx, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Postgres görev deposu; `@squaresdk/solana-db` isteğe bağlı peer bağımlılıktır ve yalnızca burada yüklenir. */
async function postgresStore(url: string): Promise<TaskStore> {
  const [{ createDatabaseClient }, { createPrismaTaskStore }] = await Promise.all([
    import('@squaresdk/solana-db'),
    import('@squaresdk/solana-a2a/prisma'),
  ]);
  return createPrismaTaskStore(createDatabaseClient({ connectionString: url }));
}

export interface RunnerOverrides {
  store?: TaskStore;
  anthropic?: MessagesClient;
  connection?: Connection;
  prover?: Prover;
  logger?: AgentLogger;
  extra?: Partial<HostedDeps>;
}

/** Yüklü yapılandırmadan `createHostedAgent` bağımlılıkları; dosyalar ve ortam burada denetlenir. */
export async function depsFromConfig(
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv,
  overrides: RunnerOverrides = {},
): Promise<HostedDeps> {
  const { config, policy } = loaded;
  assertEnv(config, env);
  const agentSigner = await readKeypairFile(config.signers.agent.keypairPath);
  const institution = await institutionSigner(config);
  let proofs: HostedDeps['proofs'] = null;
  const watch = config.duties?.policyWatch;
  if (watch) {
    const salts: PolicySalts = derivePolicySalts(
      await readPolicySecret(watch.policySecretPath),
      Uint8Array.from(Buffer.from(policy!.policyId, 'hex')),
    );
    const prover =
      overrides.prover ??
      createRemoteProver({
        baseUrl: watch.prover.baseUrl,
        apiKey: envRequired(watch.prover.apiKeyEnv, env),
        artifactVersion: watch.prover.artifactVersion,
      });
    proofs = { salts, prover };
  }
  const logger = overrides.logger;
  const outbox = config.signers.institution?.type === 'unsigned' ? config.signers.institution.outboxDir : undefined;
  return {
    connection: overrides.connection ?? new Connection(config.chain.rpcUrl, config.chain.commitment),
    store: overrides.store ?? (await postgresStore(envRequired(config.store.urlEnv, env))),
    anthropic: overrides.anthropic ?? new (await import('@anthropic-ai/sdk')).default(),
    agentSigner,
    ...(institution && { institutionSigner: institution }),
    policy,
    ledger: config.delegation ? createFileLedger(config.delegation.ledgerPath) : createMemoryLedger(),
    proofs,
    env,
    ...(logger && { logger }),
    onUnsignedTx: (tx) => {
      const where = outbox ? writeUnsignedTx(outbox, tx) : null;
      logger?.info(`imzasız tx: job ${tx.job} adım ${tx.step}${where ? ` → ${where}` : ''}`);
    },
    onDutyAction: (action) =>
      logger?.info(
        `duty ${action.duty}: ${action.action} job ${action.job}${action.signature ? ` ${action.signature}` : ''}`,
      ),
    ...overrides.extra,
  };
}

/** Yapılandırmayı yükler; `check` ise yalnızca doğrular, değilse agent'ı başlatır. */
export async function runFromConfig(
  args: RunnerArgs,
  env: NodeJS.ProcessEnv,
  overrides: RunnerOverrides = {},
): Promise<{ loaded: LoadedConfig; hosted: HostedAgent | null }> {
  const loaded = await loadHostedConfig(args.config);
  if (args.check) {
    assertEnv(loaded.config, env);
    await readKeypairFile(loaded.config.signers.agent.keypairPath);
    await institutionSigner(loaded.config);
    const watch = loaded.config.duties?.policyWatch;
    if (watch) await readPolicySecret(watch.policySecretPath);
    return { loaded, hosted: null };
  }
  const hosted = await createHostedAgent(loaded.config, await depsFromConfig(loaded, env, overrides));
  try {
    await hosted.start();
  } catch (error) {
    await hosted.close();
    throw error;
  }
  return { loaded, hosted };
}
