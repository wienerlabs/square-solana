import { describe, expect, it } from 'vitest';
import { caip2ChainId, parseWebConfig, rpcLabel } from '../src/lib/config';

const valid = { SQUARE_SOLANA_CLUSTER: 'devnet', SQUARE_SOLANA_RPC_URL: 'https://rpc.example.org/v1?api-key=secret' };

describe('parseWebConfig', () => {
  it('accepts a cluster and an https RPC URL', () => {
    expect(parseWebConfig(valid)).toEqual({
      ok: true,
      config: { cluster: 'devnet', rpcUrl: 'https://rpc.example.org/v1?api-key=secret' },
    });
  });

  it('has no defaults: both variables are required', () => {
    const result = parseWebConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(['SQUARE_SOLANA_CLUSTER is not set', 'SQUARE_SOLANA_RPC_URL is not set']);
    }
  });

  it('rejects an unknown cluster', () => {
    const result = parseWebConfig({ ...valid, SQUARE_SOLANA_CLUSTER: 'mainnet' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/must be one of devnet, testnet, mainnet-beta, localnet/);
  });

  it('rejects a malformed URL and a non-http scheme', () => {
    expect(parseWebConfig({ ...valid, SQUARE_SOLANA_RPC_URL: 'not a url' }).ok).toBe(false);
    expect(parseWebConfig({ ...valid, SQUARE_SOLANA_RPC_URL: 'wss://rpc.example.org' }).ok).toBe(false);
  });

  it('allows http only for localnet', () => {
    expect(parseWebConfig({ ...valid, SQUARE_SOLANA_RPC_URL: 'http://rpc.example.org' }).ok).toBe(false);
    expect(
      parseWebConfig({ SQUARE_SOLANA_CLUSTER: 'localnet', SQUARE_SOLANA_RPC_URL: 'http://127.0.0.1:8899' }).ok,
    ).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = parseWebConfig({
      SQUARE_SOLANA_CLUSTER: ' devnet\n',
      SQUARE_SOLANA_RPC_URL: ' https://rpc.example.org ',
    });
    expect(result).toEqual({ ok: true, config: { cluster: 'devnet', rpcUrl: 'https://rpc.example.org' } });
  });
});

describe('display helpers', () => {
  it('shows only the RPC host, never its path, query or credentials', () => {
    expect(rpcLabel('https://user:pass@rpc.example.org:8443/v1?api-key=secret')).toBe('rpc.example.org:8443');
  });

  it('derives the CAIP-2 chain id from the genesis hash', () => {
    // Devnet genesis hash; its CAIP-2 reference is the first 32 characters.
    expect(caip2ChainId('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')).toBe(
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    );
  });
});
