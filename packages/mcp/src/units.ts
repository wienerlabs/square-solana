// Tutarlar: zincirde taban birim (u64), modelle konuşurken settlement mint'inin ondalığıyla (ör. "12.5" USDC).
import type { Cluster } from '@squaresdk/solana-types';

/** "12.5" → 12_500_000n (6 ondalık); fazla ondalık ya da sayı olmayan girdi reddedilir. */
export function toBaseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`tutar ondalık sayı olmalı: ${value}`);
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`tutar en çok ${decimals} ondalık olabilir: ${value}`);
  const units = BigInt(match[1]! + fraction.padEnd(decimals, '0'));
  if (units >= 2n ** 64n) throw new Error(`tutar u64 aralığı dışında: ${value}`);
  return units;
}

/** 12_500_000n → "12.5". */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${units / scale}${fraction ? `.${fraction}` : ''}`;
}

/** Solana Explorer bağlantısı; localnet'te explorer RPC'yi bilmez, bağlantı verilmez. */
export function explorerUrl(cluster: Cluster, path: string): string | null {
  if (cluster === 'localnet') return null;
  const base = `https://explorer.solana.com/${path}`;
  return cluster === 'mainnet-beta' ? base : `${base}?cluster=${cluster}`;
}
