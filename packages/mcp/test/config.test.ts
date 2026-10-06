// Yapılandırma: zorunlu değişkenler, isteğe bağlı imzacı, ALT, priority fee ve API.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PROGRAM_IDS } from './helpers/world.js';

const BASE = {
  SQUARE_MCP_CLUSTER: 'devnet',
  SQUARE_MCP_RPC_URL: 'https://api.devnet.solana.com',
  SQUARE_MCP_TIMEOUT_MS: '10000',
  SQUARE_MCP_CARD_MAX_BYTES: '65536',
  SQUARE_PROGRAM_ID_REGISTRY: PROGRAM_IDS.registry.toBase58(),
  SQUARE_PROGRAM_ID_POLICY: PROGRAM_IDS.policy.toBase58(),
  SQUARE_PROGRAM_ID_VERIFIER: PROGRAM_IDS.verifier.toBase58(),
  SQUARE_PROGRAM_ID_ESCROW: PROGRAM_IDS.escrow.toBase58(),
};

describe('loadConfig', () => {
  it('zorunlu değerlerle salt okunur sunucu: imzacı, ALT, ücret ve API yok', () => {
    const config = loadConfig({ ...BASE, SQUARE_MCP_KEYPAIR: ' ', SQUARE_API_URL: '' });
    expect(config).toMatchObject({
      cluster: 'devnet',
      timeoutMs: 10_000,
      cardMaxBytes: 65_536,
      signer: null,
      lookupTable: null,
      computeUnitPrice: null,
      api: null,
    });
    expect(config.programIds.escrow.equals(PROGRAM_IDS.escrow)).toBe(true);
  });

  it('isteğe bağlı değerler: keypair dosyası, ALT, priority fee, API (sondaki / atılır)', () => {
    const signer = Keypair.generate();
    const config = loadConfig(
      {
        ...BASE,
        SQUARE_MCP_KEYPAIR: '/keys/agent.json',
        SQUARE_MCP_LOOKUP_TABLE: PROGRAM_IDS.registry.toBase58(),
        SQUARE_MCP_COMPUTE_UNIT_PRICE: '5000',
        SQUARE_API_URL: 'https://api.square.test/',
        SQUARE_API_KEY: 'sk_live',
      },
      (path) => {
        expect(path).toBe('/keys/agent.json');
        return JSON.stringify(Array.from(signer.secretKey));
      },
    );
    expect(config.signer!.publicKey.equals(signer.publicKey)).toBe(true);
    expect(config).toMatchObject({
      computeUnitPrice: 5_000n,
      api: { url: 'https://api.square.test', apiKey: 'sk_live' },
    });
    expect(config.lookupTable!.equals(PROGRAM_IDS.registry)).toBe(true);
  });

  it('eksik ve geçersiz değerler; keypair içeriği hata mesajına yazılmaz', () => {
    const { SQUARE_MCP_RPC_URL: _rpc, ...withoutRpc } = BASE;
    expect(() => loadConfig({ ...withoutRpc, SQUARE_MCP_CLUSTER: 'moon' })).toThrow(
      /SQUARE_MCP_CLUSTER[\s\S]*SQUARE_MCP_RPC_URL/,
    );
    expect(() => loadConfig({ ...BASE, SQUARE_PROGRAM_ID_ESCROW: 'not-an-address' })).toThrow(
      /SQUARE_PROGRAM_ID_ESCROW: base58/,
    );
    expect(() => loadConfig({ ...BASE, SQUARE_API_URL: 'https://api.test' })).toThrow(/birlikte verilir/);
    const secret = JSON.stringify(Array.from(Keypair.generate().secretKey.subarray(0, 32)));
    let message = '';
    try {
      loadConfig({ ...BASE, SQUARE_MCP_KEYPAIR: '/k.json' }, () => secret);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/keypair dosyası okunamadı \(64 baytlık dizi değil\)/);
    expect(message).not.toContain(secret);
    expect(() => loadConfig({ ...BASE, SQUARE_MCP_KEYPAIR: '/k.json' }, () => '{')).toThrow(/JSON değil/);
    expect(() => loadConfig({ ...BASE, SQUARE_MCP_LOOKUP_TABLE: 'x' })).toThrow(/SQUARE_MCP_LOOKUP_TABLE/);
    expect(() => loadConfig({ ...BASE, SQUARE_MCP_TIMEOUT_MS: '0' })).toThrow(/SQUARE_MCP_TIMEOUT_MS/);
  });
});
