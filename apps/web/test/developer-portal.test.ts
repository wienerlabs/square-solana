// Geliştirici portalının saf parçaları (FE-22): cüzdanla API oturumu (imza gerçekten doğrulanır), ücretli uç
// nokta formu, fiyat gösterimi, ağ ve USDC sabitlerinin x402 paketi ve API sözleşmesiyle hizası, yapılandırma.
import { createApiClient } from '@squaresdk/solana-sdk';
import { ApiKeyScopeSchema, X402NetworkSchema } from '@squaresdk/solana-types';
import { SOLANA_NETWORKS, usdcMint } from '@squaresdk/solana-x402';
import { describe, expect, it } from 'vitest';
import { parseWebConfig } from '@/lib/config';
import {
  PortalApiError,
  SCOPE_INFO,
  USDC_MINTS,
  X402_NETWORKS,
  checkEndpointDraft,
  defaultNetwork,
  formatPrice,
  newEndpointDraft,
  signInToApi,
} from '@/lib/developer-portal';
import { fakeSquareApi, testWallet } from './helpers/fake-square-api';

const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as const;
const OTHER_MINT = 'So11111111111111111111111111111111111111112';

describe('API session', () => {
  it('signs the challenge with the wallet and opens a session', async () => {
    const fake = fakeSquareApi();
    const api = createApiClient({ baseUrl: 'https://api.square.test', fetch: fake.fetch });
    const wallet = testWallet();
    const session = await signInToApi({ api, wallet: wallet.address, signMessage: wallet.signMessage });
    expect(session).toMatchObject({ wallet: wallet.address, token: expect.stringMatching(/^sqs_/) });
    const authed = createApiClient({
      baseUrl: 'https://api.square.test',
      fetch: fake.fetch,
      auth: { session: session.token },
    });
    expect((await authed.listApiKeys()).success).toBe(true);
  });

  it('a signature from another wallet is refused with the API’s error', async () => {
    const fake = fakeSquareApi();
    const api = createApiClient({ baseUrl: 'https://api.square.test', fetch: fake.fetch });
    const wallet = testWallet();
    const attempt = signInToApi({ api, wallet: wallet.address, signMessage: testWallet().signMessage });
    await expect(attempt).rejects.toBeInstanceOf(PortalApiError);
    await expect(signInToApi({ api, wallet: wallet.address, signMessage: testWallet().signMessage })).rejects.toThrow(
      'imza geçersiz',
    );
  });
});

describe('networks, mints and scopes', () => {
  it('match @squaresdk/solana-x402 and the API contract', () => {
    expect(X402_NETWORKS.map((network) => network.id)).toEqual([...X402NetworkSchema.options]);
    expect(X402_NETWORKS.map((network) => network.id)).toEqual([...SOLANA_NETWORKS]);
    for (const network of SOLANA_NETWORKS) expect(USDC_MINTS[network]).toBe(usdcMint(network));
    expect(Object.keys(SCOPE_INFO).sort()).toEqual([...ApiKeyScopeSchema.options].sort());
  });

  it('follows the app’s cluster', () => {
    expect(defaultNetwork('mainnet-beta')).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(defaultNetwork('testnet')).toBe('solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z');
    expect(defaultNetwork('devnet')).toBe(DEVNET);
    expect(defaultNetwork('localnet')).toBe(DEVNET);
  });

  it('formats USDC prices and other mints in base units', () => {
    expect(formatPrice('250000', USDC_MINTS[DEVNET], DEVNET)).toBe('0.25 USDC');
    expect(formatPrice('1500000000', USDC_MINTS[DEVNET], DEVNET)).toBe('1,500 USDC');
    expect(formatPrice('250000', OTHER_MINT, DEVNET)).toBe('250,000 base units');
  });
});

describe('paid endpoint form', () => {
  const payTo = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1EtWTRABZaYq6';
  const valid = { ...newEndpointDraft('devnet', OTHER_MINT), name: ' Report ', path: '/v1/report', price: '0.25' };

  it('turns a USDC price into base units', () => {
    expect(newEndpointDraft('devnet', payTo)).toMatchObject({ mint: USDC_MINTS[DEVNET], network: DEVNET, payTo });
    expect(checkEndpointDraft(valid)).toEqual({
      ok: true,
      body: {
        name: 'Report',
        path: '/v1/report',
        description: null,
        amount: '250000',
        mint: USDC_MINTS[DEVNET],
        network: DEVNET,
        payTo: OTHER_MINT,
        enabled: true,
      },
    });
  });

  it('takes other mints in whole base units', () => {
    const other = checkEndpointDraft({ ...valid, mint: OTHER_MINT, price: '1000', description: ' daily ' });
    expect(other).toMatchObject({ ok: true, body: { amount: '1000', description: 'daily' } });
    expect(checkEndpointDraft({ ...valid, mint: OTHER_MINT, price: '0.5' })).toMatchObject({
      ok: false,
      errors: { price: 'Enter a whole number of the mint’s base units.' },
    });
  });

  it('reports each invalid field', () => {
    const result = checkEndpointDraft({
      ...valid,
      name: '',
      path: 'v1/report?x',
      description: 'x'.repeat(501),
      price: '0',
      mint: 'nope',
      payTo: '',
    });
    expect(result.ok).toBe(false);
    expect(Object.keys(result.ok ? {} : result.errors).sort()).toEqual(
      ['description', 'mint', 'name', 'path', 'payTo', 'price'].sort(),
    );
    expect(checkEndpointDraft({ ...valid, price: '0.0000001' })).toMatchObject({ errors: { price: /6 decimal/ } });
    expect(checkEndpointDraft({ ...valid, mint: OTHER_MINT, price: '18446744073709551616' })).toMatchObject({
      errors: { price: 'The price is too large.' },
    });
    expect(checkEndpointDraft({ ...valid, name: 'x'.repeat(81) })).toMatchObject({
      errors: { name: 'At most 80 characters.' },
    });
  });
});

describe('SQUARE_API_URL', () => {
  const base = { SQUARE_SOLANA_CLUSTER: 'devnet', SQUARE_SOLANA_RPC_URL: 'https://rpc.square.test' };
  it('is optional, trimmed of the trailing slash and must use https', () => {
    const without = parseWebConfig(base);
    expect(without.ok && 'apiUrl' in without.config).toBe(false);
    expect(parseWebConfig({ ...base, SQUARE_API_URL: 'https://api.square.test/' })).toMatchObject({
      ok: true,
      config: { apiUrl: 'https://api.square.test' },
    });
    expect(parseWebConfig({ ...base, SQUARE_API_URL: 'http://api.square.test' })).toEqual({
      ok: false,
      errors: ['SQUARE_API_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet'],
    });
  });
});
