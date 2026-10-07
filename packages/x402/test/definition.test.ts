// Portal tanımından ücretli route (FE-22): tanımın 402 gereksinimine dönüşmesi, ödeme ve bildirim, tanımın
// yenilenmesi (fiyat, pasif, silinmiş), tanım okunamazken davranış ve Square API sözleşmesiyle tip hizası.
// Ödeme resmi exact şemasıyla, sahte Solana RPC'si üzerinden gerçekten kurulur ve uzlaştırılır.
import type { X402Endpoint, X402PaymentReport } from '@squaresdk/solana-types';
import { X402NetworkSchema } from '@squaresdk/solana-types';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPayingFetch, readPaymentReceipt, type PayingFetch } from '../src/client.js';
import {
  DEFAULT_DEFINITION_REFRESH_SECONDS,
  paidRouteFromDefinition,
  type DefinitionRouteOptions,
  type X402DefinitionSource,
  type X402EndpointDefinition,
  type X402PaymentRecord,
} from '../src/definition.js';
import { createFacilitatorClient } from '../src/facilitator.js';
import { createX402Gateway, type X402Event, type X402Gateway } from '../src/gateway.js';
import { SOLANA_DEVNET, SOLANA_MAINNET, SOLANA_NETWORKS, SOLANA_TESTNET } from '../src/networks.js';
import { createMemoryReplayStore } from '../src/replay.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import {
  createWallets,
  listen,
  paymentRequiredOf,
  startFakeSolanaRpc,
  type Listening,
  type Wallets,
  TEST_LIMITS,
} from './helpers.js';

// Tip hizası: API'nin görünümü tanım olarak, bildirim kaydı API'nin gövdesi olarak doğrudan kullanılır.
const _definitionFromApi = (endpoint: X402Endpoint): X402EndpointDefinition => endpoint;
const _reportForApi = (record: X402PaymentRecord): X402PaymentReport => record;
void _definitionFromApi;
void _reportForApi;

let rpc: FakeSolanaRpc;
let wallets: Wallets;
let pay: PayingFetch;
let server: Listening | null = null;

beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
  wallets = await createWallets();
  rpc.addMint(wallets.mint, 6);
  pay = createPayingFetch({
    signer: wallets.payer,
    networks: [SOLANA_DEVNET],
    rpcUrl: rpc.url,
    spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint }] },
  });
});
afterAll(() => rpc.close());
afterEach(async () => {
  await server?.close();
  server = null;
});

const definition = (overrides: Partial<X402EndpointDefinition> = {}): X402EndpointDefinition => ({
  id: '5f0c9a3e-8a59-4c4e-9a0e-2f4f2f6f1d10',
  name: 'Rapor',
  path: '/report',
  description: 'Günlük rapor',
  amount: '250000',
  mint: wallets.mint,
  network: SOLANA_DEVNET,
  payTo: wallets.payTo,
  enabled: true,
  ...overrides,
});

function gatewayWith(events: X402Event[] = []): X402Gateway {
  return createX402Gateway({
    facilitator: createFacilitatorClient({
      feePayer: wallets.feePayer,
      rpcUrls: { [SOLANA_DEVNET]: rpc.url },
      limits: TEST_LIMITS,
    }),
    replay: createMemoryReplayStore(),
    networks: [SOLANA_DEVNET],
    onEvent: (event) => events.push(event),
  });
}

async function start(source: X402DefinitionSource, options: DefinitionRouteOptions = {}, gateway = gatewayWith()) {
  const calls = { report: 0 };
  const app = express();
  app.get('/report', paidRouteFromDefinition(gateway, source, options), (_req, res) => {
    calls.report += 1;
    res.json({ ok: true });
  });
  server = await listen(app);
  return { url: `${server.url}/report`, calls };
}

describe('Square API sözleşmesiyle hiza', () => {
  it('ağ kimlikleri API şemasındaki değerlerle aynı', () => {
    expect([...X402NetworkSchema.options]).toEqual([SOLANA_MAINNET, SOLANA_DEVNET, SOLANA_TESTNET]);
    expect([...SOLANA_NETWORKS]).toEqual([...X402NetworkSchema.options]);
  });
});

describe('paidRouteFromDefinition', () => {
  it('tanımdaki fiyat, mint, alıcı ve açıklamayla 402 ister; ödeme 200 alır ve bildirilir', async () => {
    const reports: { payment: X402PaymentRecord; definition: X402EndpointDefinition }[] = [];
    const now = Date.parse('2026-10-06T15:00:00Z');
    const { url, calls } = await start(definition(), {
      clock: () => now,
      onPayment: (payment, def) => {
        reports.push({ payment, definition: def });
      },
    });

    const unpaid = await fetch(url);
    expect(unpaid.status).toBe(402);
    const required = paymentRequiredOf(unpaid);
    expect(required.resource?.description).toBe('Günlük rapor');
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: SOLANA_DEVNET,
      amount: '250000',
      asset: wallets.mint,
      payTo: wallets.payTo,
    });
    expect(calls.report).toBe(0);

    const paid = await pay(url);
    expect(paid.status).toBe(200);
    const receipt = readPaymentReceipt(paid)!;
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]!.definition.id).toBe(definition().id);
    expect(reports[0]!.payment).toEqual({
      fingerprint: expect.stringMatching(/^svm:[0-9a-f]{64}$/),
      transaction: receipt.transaction,
      network: SOLANA_DEVNET,
      asset: wallets.mint,
      amount: '250000',
      payer: wallets.payer.address,
      payTo: wallets.payTo,
      settledAt: now / 1000,
    });
    expect(calls.report).toBe(1);
  });

  it('işleyiciden önce uzlaştırmada da bildirir; tanımın açıklaması yoksa gereksinimde de yok', async () => {
    const reports: X402PaymentRecord[] = [];
    const { url } = await start(definition({ description: null }), {
      settle: 'before-handler',
      onPayment: (payment) => void reports.push(payment),
    });
    expect(paymentRequiredOf(await fetch(url)).resource?.description).toBeFalsy();
    const paid = await pay(url);
    expect(paid.status).toBe(200);
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]!.transaction).toBe(readPaymentReceipt(paid)!.transaction);
  });

  it('bildirimin hatası yanıtı etkilemez, onError’a gider', async () => {
    const errors: unknown[] = [];
    const { url } = await start(definition(), {
      onPayment: async () => {
        throw new Error('API kapalı');
      },
      onError: (error) => errors.push(error),
    });
    expect((await pay(url)).status).toBe(200);
    await expect.poll(() => errors.length).toBe(1);
    expect((errors[0] as Error).message).toBe('API kapalı');
  });

  it('tanım süre dolunca yeniden okunur: fiyat değişir, pasif tanım 503, silinen tanım 404', async () => {
    let now = 0;
    let current: X402EndpointDefinition | null = definition();
    let reads = 0;
    const { url, calls } = await start(
      async () => {
        reads += 1;
        return current;
      },
      { clock: () => now, refreshSeconds: 10 },
    );
    expect(paymentRequiredOf(await fetch(url)).accepts[0]?.amount).toBe('250000');
    // Süre dolmadan yeniden okunmaz.
    current = definition({ amount: '500000' });
    expect(paymentRequiredOf(await fetch(url)).accepts[0]?.amount).toBe('250000');
    expect(reads).toBe(1);
    now += 10_000;
    expect(paymentRequiredOf(await fetch(url)).accepts[0]?.amount).toBe('500000');
    expect(reads).toBe(2);

    current = definition({ enabled: false });
    now += 10_000;
    const disabled = await fetch(url);
    expect(disabled.status).toBe(503);
    expect(await disabled.json()).toMatchObject({ error: 'x402_endpoint_disabled' });

    current = null;
    now += 10_000;
    const deleted = await fetch(url);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({ error: 'x402_endpoint_not_found' });
    expect(calls.report).toBe(0);
  });

  it('tanım hiç okunamadıysa 503; okunduktan sonraki hatada son bilinen tanım kullanılır', async () => {
    let now = 0;
    let fail = true;
    const errors: unknown[] = [];
    const { url } = await start(
      async () => {
        if (fail) throw new Error('API kapalı');
        return definition();
      },
      { clock: () => now, onError: (error) => errors.push(error) },
    );
    const down = await fetch(url);
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: 'x402_definition_unavailable' });
    fail = false;
    expect((await fetch(url)).status).toBe(402);
    fail = true;
    now += DEFAULT_DEFINITION_REFRESH_SECONDS * 1000;
    expect((await fetch(url)).status).toBe(402);
    expect(errors).toHaveLength(2);
  });

  it('desteklenmeyen ağdaki tanım isteği hata ara katmanına verir', async () => {
    const { url } = await start(definition({ network: 'solana:unknown' }));
    expect((await fetch(url)).status).toBe(500);
  });
});

describe('gateway onSettled', () => {
  it('geri çağırmanın hatası yanıtı bozmaz, settled_callback_error olayı olur', async () => {
    const events: X402Event[] = [];
    const gateway = gatewayWith(events);
    const app = express();
    app.get(
      '/report',
      gateway.paidRoute({
        price: { amount: '1000', asset: wallets.mint },
        payTo: wallets.payTo,
        network: SOLANA_DEVNET,
        onSettled: () => {
          throw new Error('sayaç');
        },
      }),
      (_req, res) => res.json({ ok: true }),
    );
    server = await listen(app);
    expect((await pay(`${server.url}/report`)).status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(['verified', 'settled', 'settled_callback_error']);
  });
});

describe('createMemoryReplayStore', () => {
  it('kimliği süresi dolana kadar bir kez kabul eder; süresi dolan kayıtları siler', async () => {
    const store = createMemoryReplayStore();
    const at = (ms: number) => new Date(ms);
    expect(await store.claim('x402:a', 'id', at(100), at(0))).toBe(true);
    expect(await store.claim('x402:a', 'id', at(100), at(50))).toBe(false);
    expect(await store.claim('x402:b', 'id', at(100), at(50))).toBe(true);
    expect(await store.claim('x402:a', 'id', at(200), at(100))).toBe(true);
    // Ara ara silme: binlerce kısa ömürlü kayıttan sonra eski kimlik yeniden kabul edilir.
    for (let i = 0; i < 1_000; i += 1) await store.claim('x402:a', `n${i}`, at(1_000), at(500));
    expect(await store.claim('x402:a', 'n1', at(3_000), at(2_000))).toBe(true);
  });
});
