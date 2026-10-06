// Yapılandırma: zorunlu değerler, yazma kipinin bütünlüğü, yerel imzalayıcının koşulları, HTTP ayarları.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadHttpConfig } from '../src/config.js';

const READ = { SQUARE_API_URL: 'https://api.square.test/', SQUARE_NETWORK: 'devnet', SQUARE_TIMEOUT_MS: '5000' };
const PROGRAM = Keypair.generate().publicKey.toBase58();
const WRITE = {
  ...READ,
  SQUARE_API_KEY: 'sqk_x',
  SQUARE_RPC_URL: 'http://rpc.test',
  SQUARE_ESCROW_PROGRAM_ID: PROGRAM,
};

describe('loadConfig', () => {
  it('okuma kipi', () => {
    expect(loadConfig(READ)).toEqual({
      apiUrl: 'https://api.square.test',
      network: 'devnet',
      timeoutMs: 5000,
      apiKey: null,
      write: null,
      signerKeypairPath: null,
    });
  });

  it('yazma kipi ve yerel imzalayıcı', () => {
    expect(loadConfig({ ...WRITE, SQUARE_SIGNER_KEYPAIR: '/k.json' })).toMatchObject({
      apiKey: 'sqk_x',
      write: { rpcUrl: 'http://rpc.test', escrowProgramId: PROGRAM },
      signerKeypairPath: '/k.json',
    });
  });

  it.each([
    [{}, /SQUARE_API_URL ortam değişkeni zorunlu/],
    [{ ...READ, SQUARE_NETWORK: ' ' }, /SQUARE_NETWORK/],
    [{ ...READ, SQUARE_API_URL: 'ftp://x' }, /http\(s\)/],
    [{ ...READ, SQUARE_API_URL: 'nope' }, /geçerli bir URL/],
    [{ ...READ, SQUARE_TIMEOUT_MS: '0' }, /SQUARE_TIMEOUT_MS/],
    [{ ...READ, SQUARE_TIMEOUT_MS: '1.5' }, /SQUARE_TIMEOUT_MS/],
    [{ ...READ, SQUARE_RPC_URL: 'http://rpc.test' }, /birlikte/],
    [{ ...WRITE, SQUARE_API_KEY: undefined }, /SQUARE_API_KEY/],
    [{ ...WRITE, SQUARE_ESCROW_PROGRAM_ID: 'xyz' }, /geçerli bir adres/],
    [{ ...READ, SQUARE_SIGNER_KEYPAIR: '/k.json' }, /yalnızca yazma kipinde/],
  ])('reddeder %#', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('loadHttpConfig', () => {
  it('host, port ve izinli host listesi', () => {
    expect(loadHttpConfig({ SQUARE_MCP_HTTP_HOST: '127.0.0.1', SQUARE_MCP_HTTP_PORT: '8080' })).toEqual({
      host: '127.0.0.1',
      port: 8080,
      allowedHosts: null,
    });
    expect(
      loadHttpConfig({
        SQUARE_MCP_HTTP_HOST: '0.0.0.0',
        SQUARE_MCP_HTTP_PORT: '443',
        SQUARE_MCP_ALLOWED_HOSTS: 'mcp.square.test, localhost',
      }).allowedHosts,
    ).toEqual(['mcp.square.test', 'localhost']);
  });

  it('eksik ya da geçersiz değerleri reddeder', () => {
    expect(() => loadHttpConfig({ SQUARE_MCP_HTTP_PORT: '1' })).toThrow(/SQUARE_MCP_HTTP_HOST/);
    expect(() => loadHttpConfig({ SQUARE_MCP_HTTP_HOST: 'h', SQUARE_MCP_HTTP_PORT: '70000' })).toThrow(/1–65535/);
    expect(() =>
      loadHttpConfig({ SQUARE_MCP_HTTP_HOST: 'h', SQUARE_MCP_HTTP_PORT: '1', SQUARE_MCP_ALLOWED_HOSTS: ' , ' }),
    ).toThrow(/en az bir/);
  });
});
