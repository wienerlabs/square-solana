// Tutar dönüşümleri ve Explorer bağlantısı.
import { describe, expect, it } from 'vitest';
import { explorerUrl, fromBaseUnits, toBaseUnits } from '../src/units.js';

describe('tutarlar', () => {
  it('ondalık ↔ taban birim', () => {
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n);
    expect(toBaseUnits('7', 6)).toBe(7_000_000n);
    expect(fromBaseUnits(12_500_000n, 6)).toBe('12.5');
    expect(fromBaseUnits(999_900n, 6)).toBe('0.9999');
    expect(fromBaseUnits(0n, 6)).toBe('0');
    expect(() => toBaseUnits('1e3', 6)).toThrow(/ondalık sayı/);
    expect(() => toBaseUnits('18446744073709.551616', 6)).toThrow(/u64/);
  });

  it('Explorer: mainnet kümesiz, diğerleri kümeyle, localnet bağlantısız', () => {
    expect(explorerUrl('mainnet-beta', 'tx/abc')).toBe('https://explorer.solana.com/tx/abc');
    expect(explorerUrl('testnet', 'tx/abc')).toBe('https://explorer.solana.com/tx/abc?cluster=testnet');
    expect(explorerUrl('localnet', 'tx/abc')).toBeNull();
  });
});
