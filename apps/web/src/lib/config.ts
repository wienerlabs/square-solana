// Web uygulamasının çalışma anı yapılandırması. Değerler ortamdan gelir ve kök layout'ta, istek anında
// sunucuda okunur (`connection()` sonrası); derlemeye gömülmez. Kodda varsayılan ağ ya da RPC adresi yoktur:
// eksik ya da geçersiz bir değer, uygulama yerine yapılandırma hatası sayfasını gösterir.

import { PublicKey } from '@solana/web3.js';

export const CLUSTERS = ['devnet', 'testnet', 'mainnet-beta', 'localnet'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const ENV_VARS = {
  cluster: 'SQUARE_SOLANA_CLUSTER',
  rpcUrl: 'SQUARE_SOLANA_RPC_URL',
  proverUrl: 'SQUARE_PROVER_URL',
  apiUrl: 'SQUARE_API_URL',
} as const;

export const PROGRAMS = ['registry', 'policy', 'verifier', 'escrow'] as const;
export type ProgramName = (typeof PROGRAMS)[number];

/** Program kimlikleri db ve SDK'daki gibi ortamdan gelir (BC-09'a kadar henüz atanmadı); IDL'deki adres kullanılmaz. */
export const PROGRAM_ID_ENV: Readonly<Record<ProgramName, string>> = {
  registry: 'SQUARE_PROGRAM_ID_REGISTRY',
  policy: 'SQUARE_PROGRAM_ID_POLICY',
  verifier: 'SQUARE_PROGRAM_ID_VERIFIER',
  escrow: 'SQUARE_PROGRAM_ID_ESCROW',
};

export interface WebConfig {
  cluster: Cluster;
  /** JSON-RPC uç noktası. WebSocket adresi web3.js tarafından bundan türetilir. */
  rpcUrl: string;
  /** Yapılandırılmış program kimlikleri. Şimdilik isteğe bağlı: tanımlı olmayan program "yapılandırılmamış" görünür. */
  programIds: Partial<Record<ProgramName, string>>;
  /** İsteğe bağlı: release ispatını üreten prover servisinin kök adresi (`apps/prover`, FE-09). */
  proverUrl?: string;
  /** İsteğe bağlı: Square API'nin kök adresi (`apps/api`, BE-18); keeper günlüğü (FE-10), dispute kanıtı ve arbitrator konsolu (FE-17). */
  apiUrl?: string;
}

export type WebConfigResult = { ok: true; config: WebConfig } | { ok: false; errors: string[] };

const isCluster = (value: string): value is Cluster => (CLUSTERS as readonly string[]).includes(value);

export function parseWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfigResult {
  const errors: string[] = [];
  const cluster = env[ENV_VARS.cluster]?.trim() ?? '';
  const rpcUrl = env[ENV_VARS.rpcUrl]?.trim() ?? '';

  if (!cluster) errors.push(`${ENV_VARS.cluster} is not set`);
  else if (!isCluster(cluster))
    errors.push(`${ENV_VARS.cluster} must be one of ${CLUSTERS.join(', ')}; got "${cluster}"`);

  if (!rpcUrl) errors.push(`${ENV_VARS.rpcUrl} is not set`);
  else errors.push(...urlProblems(ENV_VARS.rpcUrl, rpcUrl, cluster));

  const proverUrl = env[ENV_VARS.proverUrl]?.trim() || undefined;
  if (proverUrl) errors.push(...urlProblems(ENV_VARS.proverUrl, proverUrl, cluster));
  const apiUrl = env[ENV_VARS.apiUrl]?.trim() || undefined;
  if (apiUrl) errors.push(...urlProblems(ENV_VARS.apiUrl, apiUrl, cluster));

  const programIds: Partial<Record<ProgramName, string>> = {};
  for (const program of PROGRAMS) {
    const variable = PROGRAM_ID_ENV[program];
    const value = env[variable]?.trim();
    if (!value) continue;
    if (isAddress(value)) programIds[program] = value;
    else errors.push(`${variable} is not a Solana address`);
  }

  if (errors.length > 0 || !isCluster(cluster)) return { ok: false, errors };
  return {
    ok: true,
    config: { cluster, rpcUrl, programIds, ...(proverUrl && { proverUrl }), ...(apiUrl && { apiUrl }) },
  };
}

/** https adresi; http yalnızca localnet'te (tarayıcı adrese doğrudan gider). */
function urlProblems(variable: string, value: string, cluster: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${variable} is not a valid URL`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [`${variable} must use https (or http for localnet); got ${url.protocol}`];
  }
  if (url.protocol === 'http:' && cluster !== 'localnet') {
    return [`${variable} must use https unless ${ENV_VARS.cluster} is localnet`];
  }
  return [];
}

/** 32 baytlık, kanonik base58 yazılmış bir Solana adresi mi? */
export function isAddress(value: string): boolean {
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

/** Ekranda gösterilecek RPC etiketi: yalnızca host. Yol, sorgu ve kimlik bilgisi (ör. API anahtarı) gösterilmez. */
export function rpcLabel(rpcUrl: string): string {
  return new URL(rpcUrl).host;
}

/** CAIP-2 zincir kimliği: `solana:` + genesis hash'inin ilk 32 karakteri (did:aip v2 Solana profili §3.3). */
export function caip2ChainId(genesisHash: string): string {
  return `solana:${genesisHash.slice(0, 32)}`;
}
