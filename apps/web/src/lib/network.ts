// Ağ koruması (FE-03): işlemlerin yapılandırmadaki kümeye gittiği doğrulanmadan imza istenmez.
// RPC'nin genesis hash'i kümenin CAIP-2 referansıyla (did:aip v2 Solana profili §3.3; değerler
// @squaresdk/solana-identity'de) karşılaştırılır. Cüzdanın Wallet Standard hesabı kümenin zincirini
// listelemiyorsa da işlem kapatılır.
import {
  SOLANA_DEVNET_CHAIN,
  SOLANA_LOCALNET_CHAIN,
  SOLANA_MAINNET_CHAIN,
  SOLANA_TESTNET_CHAIN,
  type SolanaChain,
} from '@solana/wallet-standard-chains';
import { CHAIN_REFS } from '@squaresdk/solana-identity/constants';
import { CLUSTERS, type Cluster } from './config';

/** Kümenin CAIP-2 referansı. localnet'in genesis'i her doğrulayıcıda farklıdır; karşılığı yoktur. */
const CHAIN_REF: Readonly<Record<Cluster, string | null>> = {
  'mainnet-beta': CHAIN_REFS.mainnetBeta,
  devnet: CHAIN_REFS.devnet,
  testnet: CHAIN_REFS.testnet,
  localnet: null,
};

/** Kümenin Wallet Standard zincir kimliği. */
export const WALLET_CHAIN: Readonly<Record<Cluster, SolanaChain>> = {
  'mainnet-beta': SOLANA_MAINNET_CHAIN,
  devnet: SOLANA_DEVNET_CHAIN,
  testnet: SOLANA_TESTNET_CHAIN,
  localnet: SOLANA_LOCALNET_CHAIN,
};

/** Genesis hash'i bilinen bir public kümeninse o küme, değilse null. */
export function clusterOfGenesis(genesisHash: string): Cluster | null {
  const ref = genesisHash.slice(0, 32);
  return CLUSTERS.find((cluster) => CHAIN_REF[cluster] === ref) ?? null;
}

/**
 * RPC yapılandırmadaki kümede değilse sebebi, uygunsa null. localnet için genesis'in herhangi bir
 * public kümeye ait olmaması yeterlidir.
 */
export function rpcMismatch(cluster: Cluster, genesisHash: string): string | null {
  const actual = clusterOfGenesis(genesisHash);
  if (actual === cluster || (cluster === 'localnet' && actual === null)) return null;
  return `The RPC is on ${actual ?? 'an unrecognised cluster'}, but this app is configured for ${cluster}.`;
}

/**
 * Cüzdan hesabı kümenin zincirini listelemiyorsa sebebi. Zincir listesi olmayan (Wallet Standard dışı)
 * adapter'larda ve localnet'te kontrol yapılmaz: işlemi cüzdan değil uygulamanın bağlantısı gönderir.
 */
export function walletMismatch(cluster: Cluster, walletName: string, chains: readonly string[] | null): string | null {
  if (cluster === 'localnet' || !chains || chains.length === 0) return null;
  const chain = WALLET_CHAIN[cluster];
  return chains.includes(chain) ? null : `${walletName} does not offer ${chain} for this account.`;
}
