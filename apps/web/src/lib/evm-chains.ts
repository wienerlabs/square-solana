// EVM zincir kimliğinden zincirin adı ve blok gezgini (FE-19, CCTP'nin kaynak zinciri), viem'in zincir
// kayıtlarından. Yalnızca sunucuda kullanılır (kök layout, sağlık ucu): kayıtların tamamı istemci paketine
// girmez, sonuç yapılandırmayla istemciye geçer.
import * as chains from 'viem/chains';
import type { EvmChainLookup } from './config';

interface ChainRecord {
  id: number;
  name: string;
  blockExplorers?: { default?: { url?: string } };
}

const isChain = (value: unknown): value is ChainRecord =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ChainRecord).id === 'number' &&
  typeof (value as ChainRecord).name === 'string';

let byId: Map<number, ChainRecord> | null = null;

/** Aynı kimliği taşıyan kayıtlardan ilki (ör. Base Sepolia'nın ön onaylı kopyası aynı ad ve gezginle gelir). */
function registry(): Map<number, ChainRecord> {
  if (!byId) {
    byId = new Map();
    for (const chain of Object.values(chains) as unknown[]) {
      if (isChain(chain) && !byId.has(chain.id)) byId.set(chain.id, chain);
    }
  }
  return byId;
}

export const evmChainInfo: EvmChainLookup = (chainId) => {
  const chain = registry().get(chainId);
  if (!chain) return null;
  const explorer = chain.blockExplorers?.default?.url;
  return { name: chain.name, explorerUrl: explorer ? explorer.replace(/\/+$/, '') : null };
};
