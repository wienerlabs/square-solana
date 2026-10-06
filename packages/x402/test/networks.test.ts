import { describe, expect, it } from 'vitest';
import {
  isSolanaNetwork,
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  SOLANA_NETWORKS,
  SOLANA_TESTNET,
  toSolanaNetwork,
  usdcMint,
} from '../src/networks.js';

describe('ağ kimlikleri', () => {
  it('CAIP-2 kimlikleri genesis hash önekidir', () => {
    expect(SOLANA_MAINNET).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(SOLANA_DEVNET).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    expect(SOLANA_TESTNET).toBe('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z');
    expect(SOLANA_NETWORKS).toHaveLength(3);
  });

  it('v1 adlarını ve takma adları CAIP-2ye çevirir', () => {
    expect(toSolanaNetwork('solana')).toBe(SOLANA_MAINNET);
    expect(toSolanaNetwork('mainnet-beta')).toBe(SOLANA_MAINNET);
    expect(toSolanaNetwork(' Mainnet ')).toBe(SOLANA_MAINNET);
    expect(toSolanaNetwork('solana-devnet')).toBe(SOLANA_DEVNET);
    expect(toSolanaNetwork('devnet')).toBe(SOLANA_DEVNET);
    expect(toSolanaNetwork('solana-testnet')).toBe(SOLANA_TESTNET);
    expect(toSolanaNetwork(SOLANA_DEVNET)).toBe(SOLANA_DEVNET);
  });

  it('bilinmeyen ağı reddeder', () => {
    expect(() => toSolanaNetwork('eip155:8453')).toThrow(/bilinmeyen/);
    expect(() => toSolanaNetwork('solana:başka')).toThrow(/bilinmeyen/);
    expect(isSolanaNetwork('solana:*')).toBe(false);
  });

  it('USDC mintleri', () => {
    expect(usdcMint(SOLANA_MAINNET)).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(usdcMint(SOLANA_DEVNET)).toBe('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
    expect(usdcMint(SOLANA_TESTNET)).toBe(usdcMint(SOLANA_DEVNET));
  });
});
