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
  feePayerUrl: 'SQUARE_FEE_PAYER_URL',
  lookupTable: 'SQUARE_LOOKUP_TABLE',
} as const;

/**
 * CCTP ile fonlamanın kaynak zinciri (FE-19, docs/design/cctp-funding.md). Hepsi birlikte verilir ya da hiçbiri;
 * değerler ağın yapılandırmasındadır (`scripts/deploy/networks/<ağ>.json`, `cctp`).
 */
export const CCTP_ENV_PREFIX = 'SQUARE_CCTP_';
export const CCTP_ENV_VARS = {
  chainId: `${CCTP_ENV_PREFIX}SOURCE_CHAIN_ID`,
  domain: `${CCTP_ENV_PREFIX}SOURCE_DOMAIN`,
  tokenMessenger: `${CCTP_ENV_PREFIX}TOKEN_MESSENGER`,
  usdc: `${CCTP_ENV_PREFIX}USDC`,
  attestationUrl: `${CCTP_ENV_PREFIX}ATTESTATION_URL`,
  messageTransmitter: `${CCTP_ENV_PREFIX}MESSAGE_TRANSMITTER`,
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

export type EvmAddress = `0x${string}`;

/** EVM zincirinin adı ve blok gezgini; zincir kimliğinden, sunucuda (`evm-chains.ts`). */
export interface EvmChainInfo {
  name: string;
  /** Gezginin kök adresi (sonda `/` olmadan); zincirin kaydında yoksa null. */
  explorerUrl: string | null;
}

export type EvmChainLookup = (chainId: number) => EvmChainInfo | null;

/** CCTP'nin kaynak zinciri: USDC'nin yakıldığı EVM zinciri ve Circle'daki karşılığı. */
export interface CctpSource {
  chain: EvmChainInfo & { id: number };
  /** Circle domain kimliği (Ethereum 0, Arbitrum 3, Base 6 …); API'ye kayıtta ve ücret tablosunda. */
  domain: number;
  /** `TokenMessengerV2`: burn'ün yapıldığı sözleşme. */
  tokenMessenger: EvmAddress;
  /** Kaynak zincirdeki USDC (ERC-20). */
  usdc: EvmAddress;
  /** Circle'ın attestation servisi (ücret tablosu), sonda `/` olmadan. */
  attestationUrl: string;
  /** Solana'daki `MessageTransmitterV2`: API'nin kurduğu fonlama tx'i imzalanmadan önce denetlenir. */
  messageTransmitter: string;
}

export interface WebConfig {
  cluster: Cluster;
  /** JSON-RPC uç noktası. WebSocket adresi web3.js tarafından bundan türetilir. */
  rpcUrl: string;
  /** Yapılandırılmış program kimlikleri. Şimdilik isteğe bağlı: tanımlı olmayan program "yapılandırılmamış" görünür. */
  programIds: Partial<Record<ProgramName, string>>;
  /** İsteğe bağlı: Square address lookup table'ı (BC-28; servislerde `API_LOOKUP_TABLE`); ağ sayfası durumunu gösterir. */
  lookupTable?: string;
  /** İsteğe bağlı: release ispatını üreten prover servisinin kök adresi (`apps/prover`, FE-09). */
  proverUrl?: string;
  /**
   * İsteğe bağlı: Square API'nin kök adresi (`apps/api`, BE-18; sondaki eğik çizgi olmadan); indexer'dan okunan
   * veriler, keeper günlüğü (FE-10), dispute kanıtı ve arbitrator konsolu (FE-17), geliştirici portalı (FE-22).
   */
  apiUrl?: string;
  /** İsteğe bağlı: CCTP ile başka zincirden fonlama (FE-19); `apiUrl` de gerekir (kayıt ve kurumun tx'i). */
  cctp?: CctpSource;
  /**
   * İsteğe bağlı: sponsorlu işlem servisinin kök adresi (`apps/fee-payer`, BE-27; sondaki eğik çizgi olmadan).
   * Sponsorlu gönderim ve smart account (FE-21) bunu ister; servis Square API'nin oturumunu kabul eder, bu yüzden
   * `apiUrl` de gerekir.
   */
  feePayerUrl?: string;
}

export type WebConfigResult = { ok: true; config: WebConfig } | { ok: false; errors: string[] };

const isCluster = (value: string): value is Cluster => (CLUSTERS as readonly string[]).includes(value);

/**
 * Ortamın denetimi. `evmChain` CCTP'nin kaynak zincirini adına ve gezginine çevirir; yalnızca CCTP değişkenleri
 * verilmişse kullanılır (sunucuda `evmChainInfo`).
 */
export function parseWebConfig(
  env: Readonly<Record<string, string | undefined>>,
  evmChain?: EvmChainLookup,
): WebConfigResult {
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

  // Sondaki eğik çizgi olmadan: yollar buna eklenir.
  const apiUrl = env[ENV_VARS.apiUrl]?.trim().replace(/\/+$/, '') || undefined;
  if (apiUrl) errors.push(...urlProblems(ENV_VARS.apiUrl, apiUrl, cluster));
  const feePayerUrl = env[ENV_VARS.feePayerUrl]?.trim().replace(/\/+$/, '') || undefined;
  if (feePayerUrl) {
    errors.push(...urlProblems(ENV_VARS.feePayerUrl, feePayerUrl, cluster));
    if (!apiUrl)
      errors.push(`${ENV_VARS.feePayerUrl} needs ${ENV_VARS.apiUrl}: the fee payer accepts Square API sessions`);
  }

  const programIds: Partial<Record<ProgramName, string>> = {};
  for (const program of PROGRAMS) {
    const variable = PROGRAM_ID_ENV[program];
    const value = env[variable]?.trim();
    if (!value) continue;
    if (isAddress(value)) programIds[program] = value;
    else errors.push(`${variable} is not a Solana address`);
  }
  const lookupTable = env[ENV_VARS.lookupTable]?.trim() || undefined;
  if (lookupTable && !isAddress(lookupTable)) errors.push(`${ENV_VARS.lookupTable} is not a Solana address`);
  const cctp = parseCctpSource(env, cluster, evmChain, errors);
  if (cctp && !apiUrl) errors.push(`CCTP funding needs ${ENV_VARS.apiUrl}: transfers are registered and funded there`);

  if (errors.length > 0 || !isCluster(cluster)) return { ok: false, errors };
  return {
    ok: true,
    config: {
      cluster,
      rpcUrl,
      programIds,
      ...(lookupTable && { lookupTable }),
      ...(proverUrl && { proverUrl }),
      ...(apiUrl && { apiUrl }),
      ...(cctp && { cctp }),
      ...(feePayerUrl && { feePayerUrl }),
    },
  };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** CCTP değişkenleri: hiçbiri yoksa CCTP kapalıdır; biri varsa hepsi gerekir. */
function parseCctpSource(
  env: Readonly<Record<string, string | undefined>>,
  cluster: string,
  evmChain: EvmChainLookup | undefined,
  errors: string[],
): CctpSource | undefined {
  const value = (key: keyof typeof CCTP_ENV_VARS) => env[CCTP_ENV_VARS[key]]?.trim() ?? '';
  const keys = Object.keys(CCTP_ENV_VARS) as (keyof typeof CCTP_ENV_VARS)[];
  const missing = keys.filter((key) => value(key) === '');
  if (missing.length === keys.length) return undefined;
  if (missing.length > 0) {
    errors.push(`CCTP funding needs all of its variables; not set: ${missing.map((k) => CCTP_ENV_VARS[k]).join(', ')}`);
    return undefined;
  }
  const before = errors.length;
  const chainText = value('chainId');
  const chainId = DECIMAL.test(chainText) ? Number(chainText) : NaN;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    errors.push(`${CCTP_ENV_VARS.chainId} must be a positive integer (the EVM chain id)`);
  }
  const domainText = value('domain');
  const domain = DECIMAL.test(domainText) ? Number(domainText) : NaN;
  if (!Number.isSafeInteger(domain) || domain > 4_294_967_295) {
    errors.push(`${CCTP_ENV_VARS.domain} must be a Circle domain id (an unsigned 32-bit integer)`);
  }
  for (const key of ['tokenMessenger', 'usdc'] as const) {
    if (!EVM_ADDRESS.test(value(key))) errors.push(`${CCTP_ENV_VARS[key]} is not an EVM address`);
  }
  errors.push(...urlProblems(CCTP_ENV_VARS.attestationUrl, value('attestationUrl'), cluster));
  if (!isAddress(value('messageTransmitter')))
    errors.push(`${CCTP_ENV_VARS.messageTransmitter} is not a Solana address`);
  if (errors.length > before) return undefined;

  if (!evmChain) throw new Error('parseWebConfig: CCTP is configured but no EVM chain lookup was given');
  const chain = evmChain(chainId);
  if (!chain) {
    errors.push(`${CCTP_ENV_VARS.chainId} ${chainId} is not an EVM chain this app knows (viem's chain list)`);
    return undefined;
  }
  return {
    chain: { id: chainId, ...chain },
    domain,
    tokenMessenger: value('tokenMessenger') as EvmAddress,
    usdc: value('usdc') as EvmAddress,
    attestationUrl: value('attestationUrl').replace(/\/+$/, ''),
    messageTransmitter: value('messageTransmitter'),
  };
}

/** Bu makinenin adresleri: istek makineden çıkmaz (ör. devnet'e bağlı yerel API ile deneme). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https adresi; http yalnızca localnet'te ve bu makinenin adreslerinde (tarayıcı adrese doğrudan gider). */
function urlProblems(variable: string, value: string, cluster: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [`${variable} is not a valid URL`];
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [`${variable} must use https (or http for localnet and local hosts); got ${url.protocol}`];
  }
  if (url.protocol === 'http:' && cluster !== 'localnet' && !LOCAL_HOSTS.has(url.hostname)) {
    return [
      `${variable} must use https unless ${ENV_VARS.cluster} is localnet or the host is local (localhost, 127.0.0.1, [::1])`,
    ];
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
