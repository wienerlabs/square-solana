// Ödeyen fetch: harcama sınırları ve ağ kısıtı ödeme yükü kurulmadan uygulanır.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayingFetch } from '../src/client.js';
import { SOLANA_DEVNET, SOLANA_MAINNET } from '../src/networks.js';
import type { FakeSolanaRpc } from '../src/testing.js';
import {
  createWallets,
  memoryReplayStore,
  startFakeSolanaRpc,
  startPaidApp,
  type PaidApp,
  type Wallets,
} from './helpers.js';

let rpc: FakeSolanaRpc;
let wallets: Wallets;
let app: PaidApp;

beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
  wallets = await createWallets();
  rpc.addMint(wallets.mint, 6);
  app = await startPaidApp(wallets, rpc, { replay: memoryReplayStore() });
});
afterAll(async () => {
  await app.close();
  await rpc.close();
});

describe('createPayingFetch', () => {
  it('varsayılan harcama sınırı tanınmayan mint ile ödemeyi reddeder', async () => {
    const pay = createPayingFetch({ signer: wallets.payer, networks: [SOLANA_DEVNET], rpcUrl: rpc.url });
    await expect(pay(`${app.url}/report`)).rejects.toThrow(/payment/i);
    expect(app.calls.report).toBe(0);
  });

  it('mint başına taban birim tavanı aşılırsa ödemez', async () => {
    const pay = createPayingFetch({
      signer: wallets.payer,
      networks: [SOLANA_DEVNET],
      rpcUrl: rpc.url,
      spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint, maxAmountPerPayment: '1000' }] },
    });
    await expect(pay(`${app.url}/report`)).rejects.toThrow();
    expect(app.calls.report).toBe(0);
  });

  it('istenen ağ listede değilse ödemez', async () => {
    const pay = createPayingFetch({
      signer: wallets.payer,
      networks: [SOLANA_MAINNET],
      rpcUrl: rpc.url,
      spendControls: { allowedAssets: true },
    });
    await expect(pay(`${app.url}/report`)).rejects.toThrow();
    expect(app.calls.report).toBe(0);
  });

  it('ücretsiz yanıtı olduğu gibi döner', async () => {
    const pay = createPayingFetch({ signer: wallets.payer, networks: [SOLANA_DEVNET], rpcUrl: rpc.url });
    const response = await pay(`${app.url}/yok`);
    expect(response.status).toBe(404);
  });

  it('ağsız kurulmaz', () => {
    expect(() => createPayingFetch({ signer: wallets.payer, networks: [], rpcUrl: rpc.url })).toThrow(/ağ/);
  });
});
