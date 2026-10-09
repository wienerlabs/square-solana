// Facilitator modları: kendi facilitator'ımız (varsayılan) ve HTTP üzerinden uzak facilitator. Uzak mod,
// kendi facilitator'ımızın `createFacilitatorRouter` ile açıldığı bir sunucuya karşı sınanır.
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayingFetch, readPaymentReceipt } from '../src/client.js';
import { createFacilitatorRouter } from '../src/facilitator-http.js';
import {
  createFacilitatorClient,
  createSelfFacilitator,
  DEFAULT_FACILITATOR_MODE,
  localFacilitatorClient,
} from '../src/facilitator.js';
import { SOLANA_DEVNET, SOLANA_MAINNET, SOLANA_TESTNET } from '../src/networks.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import {
  createWallets,
  listen,
  memoryReplayStore,
  startFakeSolanaRpc,
  startPaidApp,
  type Listening,
  type Wallets,
  TEST_LIMITS,
} from './helpers.js';

const TOKEN = 'x'.repeat(16) + crypto.randomUUID();

let rpc: FakeSolanaRpc;
let wallets: Wallets;
let facilitatorServer: Listening;
const errors: string[] = [];

beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
  wallets = await createWallets();
  rpc.addMint(wallets.mint, 6);
  const app = express();
  app.use(
    '/facilitator',
    createFacilitatorRouter({
      facilitator: createFacilitatorClient({
        feePayer: wallets.feePayer,
        rpcUrls: { [SOLANA_DEVNET]: rpc.url },
        limits: TEST_LIMITS,
      }),
      authToken: TOKEN,
      onError: (operation) => errors.push(operation),
    }),
  );
  facilitatorServer = await listen(app);
});
afterAll(async () => {
  await facilitatorServer.close();
  await rpc.close();
});

describe('kendi facilitator', () => {
  it('ADR 0018 varsayılanı kendi facilitator', () => {
    expect(DEFAULT_FACILITATOR_MODE).toBe('self');
  });

  it('yalnızca RPC adresi verilen ağları destekler ve ücret ödeyeni bildirir', async () => {
    const facilitator = createSelfFacilitator({
      feePayer: wallets.feePayer,
      rpcUrls: { [SOLANA_MAINNET]: rpc.url, [SOLANA_TESTNET]: rpc.url },
      limits: TEST_LIMITS,
    });
    const supported = await localFacilitatorClient(facilitator).getSupported();
    expect(supported.kinds.map((kind) => kind.network).sort()).toEqual([SOLANA_MAINNET, SOLANA_TESTNET].sort());
    expect(supported.kinds.every((kind) => kind.extra?.feePayer === wallets.feePayer.address)).toBe(true);
  });

  it('RPC adresi olmadan kurulmaz', () => {
    expect(() => createSelfFacilitator({ feePayer: wallets.feePayer, rpcUrls: {}, limits: TEST_LIMITS })).toThrow(
      /rpcUrls/,
    );
  });
});

describe('uzak facilitator (HTTP)', () => {
  const remote = (authToken?: string) =>
    createFacilitatorClient({
      mode: 'remote',
      url: `${facilitatorServer.url}/facilitator`,
      ...(authToken ? { authToken } : {}),
      timeoutMs: 5_000,
    });

  it('uçtan uca ödeme uzak facilitator üzerinden uzlaştırılır', async () => {
    const app = await startPaidApp(wallets, rpc, { replay: memoryReplayStore(), facilitator: remote(TOKEN) });
    try {
      const sentBefore = rpc.sent.length;
      const pay = createPayingFetch({
        signer: wallets.payer,
        networks: [SOLANA_DEVNET],
        rpcUrl: rpc.url,
        spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint }] },
      });
      const response = await pay(`${app.url}/report`);
      expect(response.status).toBe(200);
      expect(readPaymentReceipt(response)).toMatchObject({ success: true, payer: wallets.payer.address });
      expect(rpc.sent.length).toBe(sentBefore + 1);
    } finally {
      await app.close();
    }
  });

  it('belirteçsiz ya da yanlış belirteçli istek 401 alır', async () => {
    await expect(remote().getSupported()).rejects.toThrow(/401/);
    await expect(remote(`${TOKEN}-baska`).getSupported()).rejects.toThrow(/401/);
    const supported = await remote(TOKEN).getSupported();
    expect(supported.kinds[0]).toMatchObject({ x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET });
  });

  it('x402 v2 olmayan gövde 400 alır', async () => {
    const post = (path: string) =>
      fetch(`${facilitatorServer.url}/facilitator/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ x402Version: 1, paymentPayload: {}, paymentRequirements: {} }),
      });
    const verify = await post('verify');
    expect(verify.status).toBe(400);
    expect(await verify.json()).toMatchObject({ isValid: false, invalidReason: 'invalid_payload' });
    const settle = await post('settle');
    expect(settle.status).toBe(400);
    expect(await settle.json()).toMatchObject({ success: false, errorReason: 'invalid_payload' });
  });

  it('facilitator istisnası 500 ve gözlem kancası', async () => {
    const failing = express();
    const boom = async () => {
      throw new Error('rpc yok');
    };
    failing.use(
      createFacilitatorRouter({
        facilitator: { verify: boom, settle: boom, getSupported: boom },
        authToken: TOKEN,
        onError: (operation) => errors.push(operation),
      }),
    );
    const server = await listen(failing);
    try {
      const request = (path: string, method = 'POST') =>
        fetch(`${server.url}/${path}`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          ...(method === 'POST' ? { body: JSON.stringify(validBody()) } : {}),
        });
      expect((await request('verify')).status).toBe(500);
      expect((await request('settle')).status).toBe(500);
      expect((await request('supported', 'GET')).status).toBe(500);
      expect(errors).toEqual(['verify', 'settle', 'supported']);
    } finally {
      await server.close();
    }
  });

  it('kısa belirteçle kurulmaz', () => {
    expect(() =>
      createFacilitatorRouter({
        facilitator: localFacilitatorClient(
          createSelfFacilitator({
            feePayer: wallets.feePayer,
            rpcUrls: { [SOLANA_DEVNET]: rpc.url },
            limits: TEST_LIMITS,
          }),
        ),
        authToken: 'kısa',
      }),
    ).toThrow(/32/);
  });
});

function validBody() {
  const requirements = {
    scheme: 'exact',
    network: SOLANA_DEVNET,
    asset: wallets.mint,
    amount: '1',
    payTo: wallets.payTo,
    maxTimeoutSeconds: 60,
    extra: { feePayer: wallets.feePayer.address },
  };
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: 'AA==' } },
    paymentRequirements: requirements,
  };
}
