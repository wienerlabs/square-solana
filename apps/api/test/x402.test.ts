// x402 etiketi (FE-22): ücretli uç nokta tanımlarının yönetimi, yetki ve kullanım. Kabul: tanım oluşturulur →
// geliştiricinin sunucusu (`@squaresdk/solana-x402` `paidRouteFromDefinition`, tanımı `x402:serve` anahtarıyla
// API'den okur) ödemesiz isteğe 402 döner → ödemeli istek 200 alır → kullanım sayacı artar. Ödeme resmi exact
// şemasıyla kurulur ve geliştiricinin kendi facilitator'ı tarafından sahte Solana RPC'si üzerinden uzlaştırılır.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { X402EndpointCreate, X402PaymentReport } from '@squaresdk/solana-types';
import {
  SOLANA_DEVNET,
  SOLANA_MAINNET,
  createFacilitatorClient,
  createMemoryReplayStore,
  createPayingFetch,
  createX402Gateway,
  paidRouteFromDefinition,
  readPaymentReceipt,
} from '@squaresdk/solana-x402';
import { startFakeSolanaRpc, type FakeSolanaRpc } from '../../../packages/x402/test/solana-rpc.js';
import bs58 from 'bs58';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { apiKey, login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { wallet } from './fixtures/world.js';

let stack: Stack;
let rpc: FakeSolanaRpc;
let keys: { feePayer: KeyPairSigner; payer: KeyPairSigner; payTo: string; mint: string };

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
  rpc = await startFakeSolanaRpc();
  const [feePayer, payer, receiver, mint] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  keys = { feePayer: feePayer!, payer: payer!, payTo: receiver!.address, mint: mint!.address };
  rpc.addMint(keys.mint, 6);
});
afterAll(async () => {
  await rpc.close();
  await stack.close();
});
beforeEach(() => truncate(stack.db));

const definition = (overrides: Partial<X402EndpointCreate> = {}): X402EndpointCreate => ({
  name: 'Daily report',
  path: '/v1/report',
  description: 'Günlük rapor',
  amount: '250000',
  mint: keys.mint,
  network: SOLANA_DEVNET,
  payTo: keys.payTo,
  enabled: true,
  ...overrides,
});

const address = () => bs58.encode(randomBytes(32));
const report = (overrides: Partial<X402PaymentReport> = {}): X402PaymentReport => ({
  fingerprint: `svm:${randomBytes(32).toString('hex')}`,
  transaction: bs58.encode(randomBytes(64)),
  network: SOLANA_DEVNET,
  asset: keys.mint,
  amount: '250000',
  payer: address(),
  payTo: keys.payTo,
  settledAt: 1_791_300_000,
  ...overrides,
});

async function created(api: SquareApi, body: X402EndpointCreate) {
  const result = await api.createX402Endpoint(body);
  if (!result.success) throw new Error(result.error.message);
  return result.data;
}

describe('tanımlar', () => {
  it('oluşturma, listeleme, okuma, kısmi güncelleme ve silme oturum sahibine aittir', async () => {
    const owner = wallet();
    const session = stack.api({ session: await login(stack.api(), owner) });
    const endpoint = await created(session, definition());
    expect(endpoint).toMatchObject({ ...definition(), id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(endpoint.createdAt).toBe(endpoint.updatedAt);
    expect(await session.listX402Endpoints()).toMatchObject({ data: [endpoint] });
    expect(await session.getX402Endpoint(endpoint.id)).toMatchObject({ data: endpoint });

    const updated = await session.updateX402Endpoint(endpoint.id, {
      enabled: false,
      amount: '500000',
      description: null,
      network: SOLANA_MAINNET,
    });
    expect(updated).toMatchObject({
      success: true,
      data: { ...endpoint, enabled: false, amount: '500000', description: null, network: SOLANA_MAINNET },
    });

    // Yol cüzdan başına tekildir; başka cüzdan aynı yolu kullanabilir ve ilk cüzdanın tanımını göremez.
    expect(await session.createX402Endpoint(definition())).toMatchObject({ error: { code: 'conflict' } });
    const second = await created(session, definition({ path: '/v1/other' }));
    expect(await session.updateX402Endpoint(second.id, { path: '/v1/report' })).toMatchObject({
      error: { code: 'conflict' },
    });
    const stranger = stack.api({ session: await login(stack.api(), wallet()) });
    await created(stranger, definition());
    expect(await stranger.getX402Endpoint(endpoint.id)).toMatchObject({ error: { code: 'not_found' } });
    expect(await stranger.updateX402Endpoint(endpoint.id, { enabled: true })).toMatchObject({
      error: { code: 'not_found' },
    });
    await expect(stranger.deleteX402Endpoint(endpoint.id)).rejects.toMatchObject({ status: 404 });
    expect(await stranger.listX402Endpoints()).toMatchObject({ data: [{ path: '/v1/report' }] });

    await session.deleteX402Endpoint(endpoint.id);
    expect(await session.getX402Endpoint(endpoint.id)).toMatchObject({ error: { code: 'not_found' } });
    expect(await session.getX402Endpoint('not-a-uuid')).toMatchObject({ error: { code: 'not_found' } });
    await expect(session.deleteX402Endpoint('not-a-uuid')).rejects.toMatchObject({ status: 404 });
    expect(await session.listX402Endpoints()).toMatchObject({ data: [{ id: second.id }] });
  });

  it('geçersiz tanım ve boş güncelleme 400 alır', async () => {
    const session = stack.api({ session: await login(stack.api(), wallet()) });
    expect(await session.createX402Endpoint(definition({ amount: '0' }))).toMatchObject({
      error: { code: 'invalid_input', details: { issues: [{ path: 'amount' }] } },
    });
    expect(await session.createX402Endpoint(definition({ path: 'report' }))).toMatchObject({
      error: { code: 'invalid_input', details: { issues: [{ path: 'path' }] } },
    });
    expect(await session.createX402Endpoint(definition({ network: 'solana' as never }))).toMatchObject({
      error: { code: 'invalid_input' },
    });
    const endpoint = await created(session, definition());
    expect(await session.updateX402Endpoint(endpoint.id, {})).toMatchObject({ error: { code: 'invalid_input' } });
  });

  it('yetki: oturumsuz 401; anahtar x402:serve ile okur ve bildirir ama yönetemez', async () => {
    const owner = wallet();
    const session = stack.api({ session: await login(stack.api(), owner) });
    const endpoint = await created(session, definition());
    const anonymous = stack.api();
    expect(await anonymous.listX402Endpoints()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await anonymous.createX402Endpoint(definition())).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await anonymous.getX402EndpointUsage(endpoint.id)).toMatchObject({ error: { code: 'unauthorized' } });

    const reader = stack.api({ apiKey: await apiKey(stack, owner, ['read']) });
    expect(await reader.listX402Endpoints()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await reader.recordX402Payment(endpoint.id, report())).toMatchObject({ error: { code: 'forbidden' } });

    const server = stack.api({ apiKey: await apiKey(stack, owner, ['x402:serve']) });
    expect(await server.listX402Endpoints()).toMatchObject({ data: [{ id: endpoint.id }] });
    expect(await server.getX402Endpoint(endpoint.id)).toMatchObject({ data: { id: endpoint.id } });
    expect((await server.getX402EndpointUsage(endpoint.id)).success).toBe(true);
    expect(await server.createX402Endpoint(definition({ path: '/x' }))).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(await server.updateX402Endpoint(endpoint.id, { enabled: false })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    await expect(server.deleteX402Endpoint(endpoint.id)).rejects.toMatchObject({ status: 401 });
  });
});

describe('ödeme bildirimi ve kullanım', () => {
  it('bildirim idempotenttir; tanımla uyuşmayan ve başka kayda ait ödeme reddedilir; kullanım toplanır', async () => {
    const session = stack.api({ session: await login(stack.api(), wallet()) });
    const endpoint = await created(session, definition());
    const other = await created(session, definition({ path: '/v1/other' }));
    expect(await session.getX402EndpointUsage(endpoint.id)).toMatchObject({
      data: { endpointId: endpoint.id, payments: 0, totals: [], lastPaidAt: null, recent: [] },
    });

    const first = report({ settledAt: 1_791_300_000 });
    const recorded = await session.recordX402Payment(endpoint.id, first);
    expect(recorded).toMatchObject({ success: true, data: { ...first, endpointId: endpoint.id } });
    const again = await fetch(`${stack.url}/v1/x402/endpoints/${endpoint.id}/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${await login(stack.api(), wallet())}`,
      },
      body: JSON.stringify(first),
    });
    // Başka cüzdanın tanımına bildirim yapılamaz.
    expect(again.status).toBe(404);
    const repeated = await session.recordX402Payment(endpoint.id, first);
    expect(repeated).toMatchObject({ success: true, data: { id: recorded.success && recorded.data.id } });

    expect(await session.recordX402Payment(other.id, first)).toMatchObject({ error: { code: 'conflict' } });
    expect(await session.recordX402Payment(endpoint.id, report({ transaction: first.transaction }))).toMatchObject({
      error: { code: 'conflict' },
    });
    expect(await session.recordX402Payment(endpoint.id, report({ asset: address(), payTo: address() }))).toMatchObject({
      error: { code: 'invalid_input', details: { fields: ['asset', 'payTo'] } },
    });
    expect(await session.recordX402Payment(endpoint.id, report({ network: SOLANA_MAINNET }))).toMatchObject({
      error: { code: 'invalid_input', details: { fields: ['network'] } },
    });
    expect(await session.recordX402Payment(endpoint.id, report({ fingerprint: 'abc' }))).toMatchObject({
      error: { code: 'invalid_input' },
    });

    // Fiyat değişse de bildirilen tutar sayılır.
    await session.recordX402Payment(endpoint.id, report({ amount: '500000', settledAt: 1_791_300_600 }));
    const usage = await session.getX402EndpointUsage(endpoint.id);
    if (!usage.success) throw new Error(usage.error.message);
    expect(usage.data).toMatchObject({
      payments: 2,
      totals: [{ network: SOLANA_DEVNET, asset: keys.mint, amount: '750000', payments: 2 }],
      lastPaidAt: 1_791_300_600,
    });
    expect(usage.data.recent.map((payment) => payment.amount)).toEqual(['500000', '250000']);

    // Tanım silinince kullanım kaydı da silinir.
    await session.deleteX402Endpoint(endpoint.id);
    expect(await stack.db.x402Payment.count()).toBe(0);
  });
});

describe('ödeme kaydının sahibi', () => {
  it('başka bir cüzdanın aynı ödemeyi önce bildirmesi tanım sahibinin kaydını engellemez', async () => {
    const owner = stack.api({ session: await login(stack.api(), wallet()) });
    const intruder = stack.api({ session: await login(stack.api(), wallet()) });
    const endpoint = await created(owner, definition());
    const copy = await created(intruder, definition());
    const payment = report({ settledAt: 1_791_300_000 });
    expect(await intruder.recordX402Payment(copy.id, payment)).toMatchObject({ success: true });
    expect(await owner.recordX402Payment(endpoint.id, payment)).toMatchObject({
      success: true,
      data: { ...payment, endpointId: endpoint.id },
    });
    expect(await owner.getX402EndpointUsage(endpoint.id)).toMatchObject({ data: { payments: 1 } });
  });
});

describe('kabul: tanım → 402 → ödeme → 200 → kullanım sayacı', () => {
  it('geliştiricinin sunucusu tanımı API’den okur, ödemeyi ister ve uzlaştırdığını bildirir', async () => {
    const owner = wallet();
    const session = stack.api({ session: await login(stack.api(), owner) });
    const endpoint = await created(session, definition());

    // Geliştiricinin sunucusu: kendi facilitator'ı ve tekrar deposu, tanım ve bildirim Square API'siyle.
    const square = stack.api({ apiKey: await apiKey(stack, owner, ['x402:serve']) });
    const errors: unknown[] = [];
    const gateway = createX402Gateway({
      facilitator: createFacilitatorClient({ feePayer: keys.feePayer, rpcUrls: { [SOLANA_DEVNET]: rpc.url } }),
      replay: createMemoryReplayStore(),
      networks: [SOLANA_DEVNET],
    });
    let served = 0;
    const app = express();
    app.get(
      endpoint.path,
      paidRouteFromDefinition(
        gateway,
        async () => {
          const result = await square.getX402Endpoint(endpoint.id);
          if (result.success) return result.data;
          if (result.error.code === 'not_found') return null;
          throw new Error(result.error.message);
        },
        {
          refreshSeconds: 0,
          onPayment: async (payment, current) => {
            const recorded = await square.recordX402Payment(current.id, payment);
            if (!recorded.success) throw new Error(recorded.error.message);
          },
          onError: (error) => errors.push(error),
        },
      ),
      (_req, res) => {
        served += 1;
        res.json({ report: 'ok' });
      },
    );
    const server: Server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${endpoint.path}`;
    try {
      const unpaid = await fetch(url);
      expect(unpaid.status).toBe(402);
      expect(served).toBe(0);

      const pay = createPayingFetch({
        signer: keys.payer,
        networks: [SOLANA_DEVNET],
        rpcUrl: rpc.url,
        spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: keys.mint }] },
      });
      const paid = await pay(url);
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ report: 'ok' });
      const receipt = readPaymentReceipt(paid)!;

      await expect
        .poll(async () => {
          const usage = await session.getX402EndpointUsage(endpoint.id);
          return usage.success ? usage.data.payments : -1;
        })
        .toBe(1);
      const usage = await session.getX402EndpointUsage(endpoint.id);
      expect(usage).toMatchObject({
        data: {
          totals: [{ network: SOLANA_DEVNET, asset: keys.mint, amount: '250000', payments: 1 }],
          recent: [
            {
              transaction: receipt.transaction,
              payer: keys.payer.address,
              payTo: keys.payTo,
              fingerprint: expect.stringMatching(/^svm:[0-9a-f]{64}$/),
            },
          ],
        },
      });
      expect(served).toBe(1);

      // Portalda pasifleştirilen uç nokta ödeme istemez ve işleyiciyi çalıştırmaz.
      await session.updateX402Endpoint(endpoint.id, { enabled: false });
      expect((await fetch(url)).status).toBe(503);
      await session.deleteX402Endpoint(endpoint.id);
      expect((await fetch(url)).status).toBe(404);
      expect(served).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
