// Solana ağ kimlikleri (CAIP-2) ve USDC mint'leri. x402 v2 ağı CAIP-2 ile adlandırır; v1'in kısa adları
// (`solana`, `solana-devnet`) ve yapılandırmadaki takma adlar burada tek biçime çevrilir. Değerler resmi
// `@x402/svm`'den gelir (ADR 0018).
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  SOLANA_TESTNET_CAIP2,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
  USDC_TESTNET_ADDRESS,
} from '@x402/svm';

export const SOLANA_MAINNET = SOLANA_MAINNET_CAIP2;
export const SOLANA_DEVNET = SOLANA_DEVNET_CAIP2;
export const SOLANA_TESTNET = SOLANA_TESTNET_CAIP2;

export type SolanaNetwork = typeof SOLANA_MAINNET | typeof SOLANA_DEVNET | typeof SOLANA_TESTNET;

export const SOLANA_NETWORKS: readonly SolanaNetwork[] = [SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET];

const ALIASES: Readonly<Record<string, SolanaNetwork>> = {
  mainnet: SOLANA_MAINNET,
  'mainnet-beta': SOLANA_MAINNET,
  solana: SOLANA_MAINNET,
  devnet: SOLANA_DEVNET,
  'solana-devnet': SOLANA_DEVNET,
  testnet: SOLANA_TESTNET,
  'solana-testnet': SOLANA_TESTNET,
};

const USDC: Readonly<Record<SolanaNetwork, string>> = {
  [SOLANA_MAINNET]: USDC_MAINNET_ADDRESS,
  [SOLANA_DEVNET]: USDC_DEVNET_ADDRESS,
  [SOLANA_TESTNET]: USDC_TESTNET_ADDRESS,
};

export function isSolanaNetwork(value: string): value is SolanaNetwork {
  return (SOLANA_NETWORKS as readonly string[]).includes(value);
}

/**
 * CAIP-2 kimliğini, v1 adını (`solana`, `solana-devnet`, `solana-testnet`) ya da takma adı (`mainnet`,
 * `mainnet-beta`, `devnet`, `testnet`) CAIP-2'ye çevirir. Bilinmeyen değerde hata verir: ödeme yanlış
 * ağda istenmez.
 */
export function toSolanaNetwork(value: string): SolanaNetwork {
  const trimmed = value.trim();
  if (isSolanaNetwork(trimmed)) return trimmed;
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  throw new Error(`bilinmeyen Solana ağı: ${value} (CAIP-2, v1 adı ya da mainnet / devnet / testnet beklenir)`);
}

/** Ağın Circle USDC mint'i (devnet ve testnet aynı mint'i kullanır). */
export function usdcMint(network: SolanaNetwork): string {
  return USDC[network];
}
