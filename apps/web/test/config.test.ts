import { describe, expect, it } from 'vitest';
import { caip2ChainId, parseWebConfig, rpcLabel } from '../src/lib/config';
import { evmChainInfo } from '../src/lib/evm-chains';

const valid = { SQUARE_SOLANA_CLUSTER: 'devnet', SQUARE_SOLANA_RPC_URL: 'https://rpc.example.org/v1?api-key=secret' };

describe('parseWebConfig', () => {
  it('accepts a cluster and an https RPC URL', () => {
    expect(parseWebConfig(valid)).toEqual({
      ok: true,
      config: { cluster: 'devnet', rpcUrl: 'https://rpc.example.org/v1?api-key=secret', programIds: {} },
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

  it('allows http only for localnet and for this machine', () => {
    expect(parseWebConfig({ ...valid, SQUARE_SOLANA_RPC_URL: 'http://rpc.example.org' }).ok).toBe(false);
    expect(
      parseWebConfig({ SQUARE_SOLANA_CLUSTER: 'localnet', SQUARE_SOLANA_RPC_URL: 'http://127.0.0.1:8899' }).ok,
    ).toBe(true);
    // Devnet'e bağlı, bu makinede çalışan servisler: istek makineden çıkmaz.
    for (const host of ['127.0.0.1:8790', 'localhost:8790', '[::1]:8790']) {
      expect(parseWebConfig({ ...valid, SQUARE_API_URL: `http://${host}` }).ok).toBe(true);
    }
    expect(parseWebConfig({ ...valid, SQUARE_API_URL: 'http://127.0.0.2:8790' }).ok).toBe(false);
    expect(parseWebConfig({ ...valid, SQUARE_API_URL: 'http://localhost.example.org' }).ok).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    const result = parseWebConfig({
      SQUARE_SOLANA_CLUSTER: ' devnet\n',
      SQUARE_SOLANA_RPC_URL: ' https://rpc.example.org ',
    });
    expect(result).toEqual({
      ok: true,
      config: { cluster: 'devnet', rpcUrl: 'https://rpc.example.org', programIds: {} },
    });
  });
});

describe('program ids', () => {
  // Gerçek adresler: Circle'ın devnet USDC mint'i ve native SOL mint'i (yalnızca biçim denetimi için).
  const A = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
  const B = 'So11111111111111111111111111111111111111112';

  it('are optional and read from SQUARE_PROGRAM_ID_*', () => {
    const result = parseWebConfig({ ...valid, SQUARE_PROGRAM_ID_REGISTRY: A, SQUARE_PROGRAM_ID_ESCROW: ` ${B} ` });
    expect(result.ok && result.config.programIds).toEqual({ registry: A, escrow: B });
  });

  it('reject a value that is not a 32-byte base58 address', () => {
    const result = parseWebConfig({
      ...valid,
      SQUARE_PROGRAM_ID_POLICY: 'not-an-address',
      SQUARE_PROGRAM_ID_VERIFIER: '1111',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'SQUARE_PROGRAM_ID_POLICY is not a Solana address',
        'SQUARE_PROGRAM_ID_VERIFIER is not a Solana address',
      ]);
    }
  });
});

describe('lookup table', () => {
  // Gerçek adres: Square'in devnet ALT'ı (docs/deploy/devnet.md).
  const ALT = '3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG';

  it('is optional and read from SQUARE_LOOKUP_TABLE', () => {
    const result = parseWebConfig({ ...valid, SQUARE_LOOKUP_TABLE: ` ${ALT} ` });
    expect(result.ok && result.config.lookupTable).toBe(ALT);
    expect(parseWebConfig({ ...valid, SQUARE_LOOKUP_TABLE: '' })).toEqual(parseWebConfig(valid));
  });

  it('rejects a value that is not a Solana address', () => {
    const result = parseWebConfig({ ...valid, SQUARE_LOOKUP_TABLE: 'alt' });
    expect(result.ok === false && result.errors).toEqual(['SQUARE_LOOKUP_TABLE is not a Solana address']);
  });
});

describe('prover', () => {
  it('is optional and follows the RPC rules', () => {
    expect(parseWebConfig({ ...valid, SQUARE_PROVER_URL: ' https://prover.example.org ' })).toEqual({
      ok: true,
      config: {
        cluster: 'devnet',
        rpcUrl: 'https://rpc.example.org/v1?api-key=secret',
        programIds: {},
        proverUrl: 'https://prover.example.org',
      },
    });
    expect(parseWebConfig({ ...valid, SQUARE_PROVER_URL: '' })).toEqual(parseWebConfig(valid));
    const insecure = parseWebConfig({ ...valid, SQUARE_PROVER_URL: 'http://prover.example.org' });
    expect(insecure.ok === false && insecure.errors).toEqual([
      'SQUARE_PROVER_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet or the host is local (localhost, 127.0.0.1, [::1])',
    ]);
    expect(
      parseWebConfig({
        SQUARE_SOLANA_CLUSTER: 'localnet',
        SQUARE_SOLANA_RPC_URL: 'http://127.0.0.1:8899',
        SQUARE_PROVER_URL: 'http://127.0.0.1:8787',
      }).ok,
    ).toBe(true);
  });
});

describe('api', () => {
  it('is optional and follows the RPC rules', () => {
    const result = parseWebConfig({ ...valid, SQUARE_API_URL: 'https://api.example.org' });
    expect(result.ok && result.config.apiUrl).toBe('https://api.example.org');
    expect(parseWebConfig({ ...valid, SQUARE_API_URL: ' ' })).toEqual(parseWebConfig(valid));
    const insecure = parseWebConfig({ ...valid, SQUARE_API_URL: 'http://api.example.org' });
    expect(insecure.ok === false && insecure.errors).toEqual([
      'SQUARE_API_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet or the host is local (localhost, 127.0.0.1, [::1])',
    ]);
  });
});

describe('cctp', () => {
  // Devnet'in değerleri (scripts/deploy/networks/devnet.json, `cctp.sources.sepolia`).
  const CCTP = {
    SQUARE_CCTP_SOURCE_CHAIN_ID: '11155111',
    SQUARE_CCTP_SOURCE_DOMAIN: '0',
    SQUARE_CCTP_TOKEN_MESSENGER: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    SQUARE_CCTP_USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    SQUARE_CCTP_ATTESTATION_URL: 'https://iris-api-sandbox.circle.com/',
    SQUARE_CCTP_MESSAGE_TRANSMITTER: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  };
  const withApi = { ...valid, SQUARE_API_URL: 'https://api.example.org' };

  it('is off without its variables, and names its source chain from the chain id', () => {
    expect(parseWebConfig(withApi, evmChainInfo)).toEqual(parseWebConfig(withApi));
    const result = parseWebConfig({ ...withApi, ...CCTP }, evmChainInfo);
    expect(result.ok && result.config.cctp).toEqual({
      chain: { id: 11155111, name: 'Sepolia', explorerUrl: 'https://sepolia.etherscan.io' },
      domain: 0,
      tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      attestationUrl: 'https://iris-api-sandbox.circle.com',
      messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
    });
  });

  it('needs all of its variables and the Square API', () => {
    const partial = parseWebConfig(
      { ...withApi, SQUARE_CCTP_SOURCE_CHAIN_ID: '11155111', SQUARE_CCTP_USDC: CCTP.SQUARE_CCTP_USDC },
      evmChainInfo,
    );
    expect(partial.ok === false && partial.errors).toEqual([
      'CCTP funding needs all of its variables; not set: SQUARE_CCTP_SOURCE_DOMAIN, SQUARE_CCTP_TOKEN_MESSENGER, SQUARE_CCTP_ATTESTATION_URL, SQUARE_CCTP_MESSAGE_TRANSMITTER',
    ]);
    const noApi = parseWebConfig({ ...valid, ...CCTP }, evmChainInfo);
    expect(noApi.ok === false && noApi.errors).toEqual([
      'CCTP funding needs SQUARE_API_URL: transfers are registered and funded there',
    ]);
  });

  it('rejects malformed values and a chain it does not know', () => {
    const result = parseWebConfig(
      {
        ...withApi,
        ...CCTP,
        SQUARE_CCTP_SOURCE_CHAIN_ID: '0xaa36a7',
        SQUARE_CCTP_SOURCE_DOMAIN: '-1',
        SQUARE_CCTP_TOKEN_MESSENGER: '0x8FE6B999',
        SQUARE_CCTP_USDC: 'usdc',
        SQUARE_CCTP_ATTESTATION_URL: 'http://iris-api-sandbox.circle.com',
        SQUARE_CCTP_MESSAGE_TRANSMITTER: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      },
      evmChainInfo,
    );
    expect(result.ok === false && result.errors).toEqual([
      'SQUARE_CCTP_SOURCE_CHAIN_ID must be a positive integer (the EVM chain id)',
      'SQUARE_CCTP_SOURCE_DOMAIN must be a Circle domain id (an unsigned 32-bit integer)',
      'SQUARE_CCTP_TOKEN_MESSENGER is not an EVM address',
      'SQUARE_CCTP_USDC is not an EVM address',
      'SQUARE_CCTP_ATTESTATION_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet or the host is local (localhost, 127.0.0.1, [::1])',
      'SQUARE_CCTP_MESSAGE_TRANSMITTER is not a Solana address',
    ]);
    const unknown = parseWebConfig({ ...withApi, ...CCTP, SQUARE_CCTP_SOURCE_CHAIN_ID: '4294967296' }, evmChainInfo);
    expect(unknown.ok === false && unknown.errors).toEqual([
      "SQUARE_CCTP_SOURCE_CHAIN_ID 4294967296 is not an EVM chain this app knows (viem's chain list)",
    ]);
  });
});

describe('fee payer', () => {
  const api = { ...valid, SQUARE_API_URL: 'https://api.example.org' };

  it('is optional, trimmed of the trailing slash and follows the RPC rules', () => {
    expect(parseWebConfig(api)).toMatchObject({ ok: true });
    expect('feePayerUrl' in (parseWebConfig(api) as { config: object }).config).toBe(false);
    expect(parseWebConfig({ ...api, SQUARE_FEE_PAYER_URL: 'https://sponsor.example.org/' })).toMatchObject({
      ok: true,
      config: { feePayerUrl: 'https://sponsor.example.org' },
    });
    expect(parseWebConfig({ ...api, SQUARE_FEE_PAYER_URL: 'http://sponsor.example.org' })).toEqual({
      ok: false,
      errors: ['SQUARE_FEE_PAYER_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet'],
    });
  });

  it('needs the Square API, whose sessions it accepts', () => {
    expect(parseWebConfig({ ...valid, SQUARE_FEE_PAYER_URL: 'https://sponsor.example.org' })).toEqual({
      ok: false,
      errors: ['SQUARE_FEE_PAYER_URL needs SQUARE_API_URL: the fee payer accepts Square API sessions'],
    });
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
