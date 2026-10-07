import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export interface WorldOptions {
  readonly deployDir: string;
  readonly ledger: string | null;
  readonly logDir: string | null;
  readonly rpcPort: number;
  readonly faucetPort: number;
  readonly gossipPort: number;
  readonly dynamicPortRange: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const port = (env: Env, name: string, fallback: number) => {
  const value = env[name];
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} geçersiz: ${value}`);
  return parsed;
};

const path = (env: Env, name: string) => {
  const value = env[name]?.trim();
  return value ? resolve(value) : null;
};

export function worldOptions(env: Env): WorldOptions {
  const range = env['SQUARE_SERVICES_DYNAMIC_PORT_RANGE'] ?? '28100-28200';
  const bounds = /^(\d+)-(\d+)$/.exec(range);
  if (!bounds || Number(bounds[1]) >= Number(bounds[2])) {
    throw new Error(`SQUARE_SERVICES_DYNAMIC_PORT_RANGE geçersiz: ${range}`);
  }
  return {
    deployDir: path(env, 'SQUARE_PROGRAMS_DIR') ?? join(REPO_ROOT, 'target/deploy'),
    ledger: path(env, 'SQUARE_SERVICES_LEDGER'),
    logDir: path(env, 'SQUARE_SERVICES_LOG_DIR'),
    rpcPort: port(env, 'SQUARE_SERVICES_RPC_PORT', 28_899),
    faucetPort: port(env, 'SQUARE_SERVICES_FAUCET_PORT', 29_900),
    gossipPort: port(env, 'SQUARE_SERVICES_GOSSIP_PORT', 28_001),
    dynamicPortRange: range,
  };
}
