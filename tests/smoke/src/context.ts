// `init` ve `smoke`'un ortak çalışma bağlamı: bağlantı, Square client'ı, rol anahtarları ve gönderici.
import { spawnSync } from 'node:child_process';
import { Connection } from '@solana/web3.js';
import { createSquareClient, type BuildOptions, type SquareClient } from '@squaresdk/solana-sdk';
import { createSender, type Sender } from './chain.js';
import type { ClusterConfig } from './config.js';
import { REPO_ROOT, type RoleKeys } from './keys.js';

export interface Context {
  config: ClusterConfig;
  connection: Connection;
  client: SquareClient;
  keys: RoleKeys;
  sender: Sender;
  log(line: string): void;
}

export function createContext(
  config: ClusterConfig,
  keys: RoleKeys,
  log: (line: string) => void,
  connection: Connection = new Connection(config.rpcUrl, { commitment: config.commitment }),
): Context {
  const client = createSquareClient({ connection, programIds: config.programIds, commitment: config.commitment });
  return { config, connection, client, keys, sender: createSender(connection, client, log), log };
}

/** Tx seçenekleri: ücret ödeyicisi, yapılandırmanın öncelik ücreti ve (varsa) Square ALT'ı. */
export function buildOptions(context: Context, feePayer: BuildOptions['feePayer']): BuildOptions {
  const { computeUnitPrice, lookupTable } = context.config;
  return {
    feePayer,
    ...(computeUnitPrice === undefined ? {} : { computeUnitPrice: BigInt(computeUnitPrice) }),
    ...(lookupTable ? { addressLookupTables: [lookupTable] } : {}),
  };
}

/** Raporun commit'i: CI'da `GITHUB_SHA`, yerelde `git rev-parse HEAD`; değişiklik varsa `+değişiklik`. */
export function currentCommit(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_SHA) return env.GITHUB_SHA;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (head.status !== 0) return 'bilinmiyor';
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return `${head.stdout.trim()}${dirty.stdout.trim() ? ' +değişiklik' : ''}`;
}

export const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
