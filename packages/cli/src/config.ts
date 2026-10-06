// Yapılandırma: küme, RPC, keypair'ler ve prover. Öncelik sırası: komut satırı bayrakları, ortam değişkenleri,
// yapılandırma dosyası (`--config`, `SQUARESDK_SOLANA_CONFIG` ya da varsa `~/.config/squaresdk-solana/config.json`),
// varsayılanlar. Dosyada sır yoktur: keypair'ler dosya yoludur, prover'ın API anahtarı yalnızca ortamdan okunur.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

export const CLUSTERS = ['localnet', 'devnet', 'mainnet-beta'] as const;
export type Cluster = (typeof CLUSTERS)[number];

/** Kümenin herkese açık RPC adresi; `--rpc-url` ile değiştirilir. */
export const DEFAULT_RPC: Readonly<Record<Cluster, string>> = Object.freeze({
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
});

/** Ortam değişkenleri. */
export const ENV = Object.freeze({
  config: 'SQUARESDK_SOLANA_CONFIG',
  cluster: 'SQUARESDK_SOLANA_CLUSTER',
  rpcUrl: 'SQUARESDK_SOLANA_RPC_URL',
  keypair: 'SQUARESDK_SOLANA_KEYPAIR',
  feePayer: 'SQUARESDK_SOLANA_FEE_PAYER',
  proverUrl: 'SQUARESDK_SOLANA_PROVER_URL',
  proverApiKey: 'SQUARESDK_SOLANA_PROVER_API_KEY',
});

const Address = z.string().refine((value) => {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}, 'base58 adres değil');

/** Yapılandırma dosyasının şeması; bilinmeyen alan reddedilir. */
export const ConfigFileSchema = z
  .object({
    cluster: z.enum(CLUSTERS).optional(),
    rpcUrl: z.url({ protocol: /^https?$/ }).optional(),
    commitment: z.enum(['confirmed', 'finalized']).optional(),
    /** İşlemleri imzalayan rol anahtarı (solana-keygen JSON). */
    keypair: z.string().min(1).optional(),
    /** Ücret ve rent ödeyen anahtar; verilmezse `keypair`. */
    feePayer: z.string().min(1).optional(),
    /** Öncelik ücreti (micro-lamport / CU). */
    computeUnitPrice: z.number().int().min(0).optional(),
    /** Square address lookup table'ı. */
    lookupTable: Address.optional(),
    prover: z
      .object({
        /** Square API ya da prover servisi; istek `<url>/v1/prove`'a gider. */
        url: z.url({ protocol: /^https?$/ }),
        /** Beklenen zkey SHA-256'sı: zincirdeki doğrulama anahtarıyla eşleşen artefakt. */
        artifactVersion: z.string().regex(/^[0-9a-f]{64}$/, '64 küçük harf hex'),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** Komutun kullandığı çözülmüş yapılandırma. */
export interface CliConfig {
  cluster: Cluster;
  rpcUrl: string;
  commitment: 'confirmed' | 'finalized';
  keypairPath: string;
  feePayerPath: string | null;
  computeUnitPrice: bigint | null;
  lookupTable: PublicKey | null;
  prover: { url: string; artifactVersion: string; apiKey: string | null } | null;
  json: boolean;
}

/** Global bayraklar (her komutta geçerli). */
export interface GlobalFlags {
  config?: string;
  cluster?: string;
  'rpc-url'?: string;
  keypair?: string;
  'fee-payer'?: string;
  'compute-unit-price'?: string;
  'lookup-table'?: string;
  'prover-url'?: string;
  'artifact-version'?: string;
  json?: boolean;
}

export const GLOBAL_OPTIONS = {
  config: { type: 'string' },
  cluster: { type: 'string' },
  'rpc-url': { type: 'string' },
  keypair: { type: 'string' },
  'fee-payer': { type: 'string' },
  'compute-unit-price': { type: 'string' },
  'lookup-table': { type: 'string' },
  'prover-url': { type: 'string' },
  'artifact-version': { type: 'string' },
  json: { type: 'boolean' },
} as const;

/** `~` ile başlayan yolu ev dizinine, göreli yolu `base`'e göre açar. */
export function expandPath(path: string, base: string = process.cwd()): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}

export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'squaresdk-solana', 'config.json');
/** Solana CLI'nin varsayılan anahtarı. */
export const DEFAULT_KEYPAIR_PATH = join(homedir(), '.config', 'solana', 'id.json');

/** Yapılandırma dosyasını okur; açıkça verilmemiş varsayılan dosya yoksa boş yapılandırma. */
export function readConfigFile(path: string | undefined, required: boolean): { file: ConfigFile; dir: string } {
  const target = path ?? DEFAULT_CONFIG_PATH;
  if (!existsSync(target)) {
    if (required) throw new Error(`yapılandırma dosyası yok: ${target}`);
    return { file: {}, dir: process.cwd() };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`yapılandırma dosyası JSON değil (${target}): ${(error as Error).message}`, { cause: error });
  }
  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '.'}: ${i.message}`).join('; ');
    throw new Error(`yapılandırma dosyası geçersiz (${target}): ${issues}`);
  }
  return { file: parsed.data, dir: resolve(target, '..') };
}

function cluster(value: string): Cluster {
  if (!(CLUSTERS as readonly string[]).includes(value)) {
    throw new Error(`bilinmeyen küme: ${value} (${CLUSTERS.join(', ')})`);
  }
  return value as Cluster;
}

function nonNegativeInt(value: string, label: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${label} negatif olmayan bir tamsayı olmalı: ${value}`);
  return BigInt(value);
}

/** Bayraklar, ortam ve dosyadan yapılandırma. */
export function resolveConfig(flags: GlobalFlags, env: NodeJS.ProcessEnv = process.env): CliConfig {
  const explicit = flags.config ?? env[ENV.config];
  const { file, dir } = readConfigFile(explicit ? expandPath(explicit) : undefined, explicit !== undefined);
  const chosen = cluster(flags.cluster ?? env[ENV.cluster] ?? file.cluster ?? 'devnet');
  const rpcUrl = flags['rpc-url'] ?? env[ENV.rpcUrl] ?? file.rpcUrl ?? DEFAULT_RPC[chosen];
  const keypair = flags.keypair ?? env[ENV.keypair];
  const feePayer = flags['fee-payer'] ?? env[ENV.feePayer];
  const price = flags['compute-unit-price'];
  const lookupTable = flags['lookup-table'] ?? file.lookupTable;
  const proverUrl = flags['prover-url'] ?? env[ENV.proverUrl] ?? file.prover?.url;
  const artifactVersion = flags['artifact-version'] ?? file.prover?.artifactVersion;
  if (artifactVersion !== undefined && !/^[0-9a-f]{64}$/.test(artifactVersion)) {
    throw new Error('--artifact-version 64 küçük harf hex olmalı (zkey SHA-256)');
  }
  return {
    cluster: chosen,
    rpcUrl,
    commitment: file.commitment ?? 'confirmed',
    keypairPath: keypair ? expandPath(keypair) : file.keypair ? expandPath(file.keypair, dir) : DEFAULT_KEYPAIR_PATH,
    feePayerPath: feePayer ? expandPath(feePayer) : file.feePayer ? expandPath(file.feePayer, dir) : null,
    computeUnitPrice:
      price !== undefined
        ? nonNegativeInt(price, '--compute-unit-price')
        : file.computeUnitPrice !== undefined
          ? BigInt(file.computeUnitPrice)
          : null,
    lookupTable: lookupTable ? new PublicKey(lookupTable) : null,
    prover:
      proverUrl && artifactVersion ? { url: proverUrl, artifactVersion, apiKey: env[ENV.proverApiKey] ?? null } : null,
    json: flags.json ?? false,
  };
}
