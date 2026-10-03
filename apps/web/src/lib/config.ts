// Web uygulamasının çalışma anı yapılandırması. Değerler ortamdan gelir ve kök layout'ta, istek anında
// sunucuda okunur (`connection()` sonrası); derlemeye gömülmez. Kodda varsayılan ağ ya da RPC adresi yoktur:
// eksik ya da geçersiz bir değer, uygulama yerine yapılandırma hatası sayfasını gösterir.

export const CLUSTERS = ['devnet', 'testnet', 'mainnet-beta', 'localnet'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const ENV_VARS = {
  cluster: 'SQUARE_SOLANA_CLUSTER',
  rpcUrl: 'SQUARE_SOLANA_RPC_URL',
} as const;

export interface WebConfig {
  cluster: Cluster;
  /** JSON-RPC uç noktası. WebSocket adresi web3.js tarafından bundan türetilir. */
  rpcUrl: string;
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

  if (!rpcUrl) {
    errors.push(`${ENV_VARS.rpcUrl} is not set`);
  } else {
    let url: URL | null = null;
    try {
      url = new URL(rpcUrl);
    } catch {
      errors.push(`${ENV_VARS.rpcUrl} is not a valid URL`);
    }
    if (url && url.protocol !== 'https:' && url.protocol !== 'http:') {
      errors.push(`${ENV_VARS.rpcUrl} must use https (or http for localnet); got ${url.protocol}`);
    } else if (url?.protocol === 'http:' && cluster !== 'localnet') {
      errors.push(`${ENV_VARS.rpcUrl} must use https unless ${ENV_VARS.cluster} is localnet`);
    }
  }

  if (errors.length > 0 || !isCluster(cluster)) return { ok: false, errors };
  return { ok: true, config: { cluster, rpcUrl } };
}

/** Ekranda gösterilecek RPC etiketi: yalnızca host. Yol, sorgu ve kimlik bilgisi (ör. API anahtarı) gösterilmez. */
export function rpcLabel(rpcUrl: string): string {
  return new URL(rpcUrl).host;
}

/** CAIP-2 zincir kimliği: `solana:` + genesis hash'inin ilk 32 karakteri (did:aip v2 Solana profili §3.3). */
export function caip2ChainId(genesisHash: string): string {
  return `solana:${genesisHash.slice(0, 32)}`;
}
