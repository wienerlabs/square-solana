import type { Connection } from '@solana/web3.js';

export const DEVNET_CHAIN_REF = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const MAINNET_CHAIN_REF = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export function clusterGuardError(cluster: string, genesisHash: string): string | null {
  const chainRef = genesisHash.slice(0, 32);
  if (chainRef === MAINNET_CHAIN_REF) {
    return `RPC mainnet-beta'ya bağlı (genesis ${genesisHash}); Square yalnızca devnet'te çalışır (ADR 0027)`;
  }
  if (cluster === 'devnet' && chainRef !== DEVNET_CHAIN_REF) {
    return `küme "devnet" ama RPC'nin genesis hash'i ${genesisHash}; devnet'inki ${DEVNET_CHAIN_REF} ile başlar`;
  }
  return null;
}

export async function assertSupportedCluster(
  connection: Pick<Connection, 'getGenesisHash'>,
  cluster: string,
): Promise<string> {
  const genesisHash = await connection.getGenesisHash();
  const error = clusterGuardError(cluster, genesisHash);
  if (error) throw new Error(error);
  return genesisHash;
}

export function isLoopbackUrl(value: string): boolean {
  const { hostname } = new URL(value);
  return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}
