// Uçtan uca: resmi exact şemasının istemcisi ve facilitator'ı, sahte Solana RPC'si, bellek içi tekrar
// deposu. 402 → ödeme başlığıyla tekrar → 200 + makbuz; aynı başlıkla tekrar → reddedilir.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPayingFetch, readPaymentReceipt, type PayingFetch } from '../src/client.js';
import type { X402Payment } from '../src/gateway.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import { paymentFingerprint } from '../src/replay.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import {
  buildPaymentHeader,
  createWallets,
  memoryReplayStore,
  paymentRequiredOf,
  PRICE_BASE_UNITS,
  recordingFetch,
  startFakeSolanaRpc,
  startPaidApp,
  type PaidApp,
  type Wallets,
} from './helpers.js';

let rpc: FakeSolanaRpc;
let wallets: Wallets;
let app: PaidApp;
let replay: ReturnType<typeof memoryReplayStore>;
let recorder: ReturnType<typeof recordingFetch>;
let pay: PayingFetch;

beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
  wallets = await createWallets();
  rpc.addMint(wallets.mint, 6);
});
afterAll(async () => {
  await rpc.close();
});
beforeEach(async () => {
  await app?.close();
  rpc.setSimulationError(null);
  replay = memoryReplayStore();
  app = await startPaidApp(wallets, rpc, { replay });
  recorder = recordingFetch();
  pay = createPayingFetch({
    signer: wallets.payer,
    networks: [SOLANA_DEVNET],
    rpcUrl: rpc.url,
    spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint }] },
    fetch: recorder.fetch,
  });
});

const paymentHeaderFor = (path: string) => buildPaymentHeader(`${app.url}${path}`, wallets, rpc);

describe('ödeme gereksinimi (402)', () => {
  it('ödemesiz isteğe 402 ve PAYMENT-REQUIRED döner, işleyici çalışmaz', async () => {
    const response = await fetch(`${app.url}/report`);
    expect(response.status).toBe(402);
    const required = paymentRequiredOf(response);
    expect(required.x402Version).toBe(2);
    expect(required.resource?.url).toBe(`${app.url}/report`);
    expect(required.resource?.description).toBe('rapor');
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: SOLANA_DEVNET,
      amount: PRICE_BASE_UNITS,
      asset: wallets.mint,
      payTo: wallets.payTo,
      extra: { feePayer: wallets.feePayer.address },
    });
    expect(app.calls.report).toBe(0);
  });
});

describe('ödeme ve makbuz', () => {
  it('ödeyen fetch öder: 200, işleyici ödeyeni görür, makbuz zincire gönderilen işlemdir', async () => {
    const response = await pay(`${app.url}/report`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { payment: X402Payment };
    expect(body.payment).toMatchObject({
      payer: wallets.payer.address,
      network: SOLANA_DEVNET,
      asset: wallets.mint,
      amount: PRICE_BASE_UNITS,
      payTo: wallets.payTo,
    });
    expect(body.payment.fingerprint).toMatch(/^svm:[0-9a-f]{64}$/);
    expect(body.payment.settlement).toBeUndefined();

    const receipt = readPaymentReceipt(response);
    expect(receipt).toMatchObject({ success: true, network: SOLANA_DEVNET, payer: wallets.payer.address });
    expect(rpc.sent).toContainEqual(expect.any(String));
    expect(receipt!.transaction).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(app.calls.report).toBe(1);
    expect(app.events.map((event) => event.type)).toEqual(['verified', 'settled']);
  });

  it('işleyiciden önce uzlaştırılan route işlem imzasını işleyiciye verir', async () => {
    const response = await pay(`${app.url}/upfront`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { payment: X402Payment };
    const receipt = readPaymentReceipt(response)!;
    expect(body.payment.settlement).toEqual({ transaction: receipt.transaction, network: SOLANA_DEVNET });
    expect(body.payment.payer).toBe(wallets.payer.address);
    expect(app.events.map((event) => event.type)).toEqual(['settled']);
  });

  it('işleyici hata dönerse ödeme uzlaştırılmaz', async () => {
    const sentBefore = rpc.sent.length;
    const response = await pay(`${app.url}/broken`);
    expect(response.status).toBe(500);
    expect(rpc.sent.length).toBe(sentBefore);
    expect(app.calls.broken).toBe(1);
  });

  it('zincirde başarısız uzlaştırma 402 döner ve settle_failed olayı üretir', async () => {
    rpc.setConfirmationError({ InstructionError: [2, { Custom: 1 }] });
    try {
      const headers = await paymentHeaderFor('/report');
      const response = await fetch(`${app.url}/report`, { headers });
      expect(response.status).toBe(402);
      expect(app.calls.report).toBe(1);
      const failed = app.events.find((event) => event.type === 'settle_failed');
      expect(failed).toMatchObject({ transaction: expect.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/) });
    } finally {
      rpc.setConfirmationError(null);
    }
  });

  it('uzlaştırma düşerse işleyicinin başlıkları 402 yanıtına sızmaz', async () => {
    rpc.setConfirmationError({ InstructionError: [2, { Custom: 1 }] });
    try {
      const headers = await paymentHeaderFor('/cookie');
      const response = await fetch(`${app.url}/cookie`, { headers });
      expect(response.status).toBe(402);
      expect(app.calls.cookie).toBe(1);
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-report-id')).toBeNull();
      expect(response.headers.get('etag')).not.toBe('"paid-etag"');
      expect(await response.text()).not.toContain('ücretli içerik');
    } finally {
      rpc.setConfirmationError(null);
    }
  });

  it('olay işleyicisi hata verse de tekrar koruması kapalı kalır', async () => {
    await app.close();
    app = await startPaidApp(wallets, rpc, {
      replay: {
        claim: async () => {
          throw new Error('veritabanı yok');
        },
      },
      onEvent: () => {
        throw new Error('günlük yok');
      },
    });
    const headers = await paymentHeaderFor('/report');
    const response = await fetch(`${app.url}/report`, { headers });
    expect(response.status).toBe(402);
    expect(paymentRequiredOf(response).error).toBe('replay_guard_unavailable');
    expect(app.calls.report).toBe(0);
  });

  it('makbuzsuz yanıtta readPaymentReceipt null döner', async () => {
    expect(readPaymentReceipt(await fetch(`${app.url}/report`))).toBeNull();
  });
});

describe('tekrar koruması', () => {
  it('aynı ödeme başlığıyla tekrar reddedilir; işleyici ve uzlaştırma ikinci kez çalışmaz', async () => {
    expect((await pay(`${app.url}/report`)).status).toBe(200);
    expect(recorder.paymentHeaders).toHaveLength(1);
    const sentBefore = rpc.sent.length;

    const replayed = await fetch(`${app.url}/report`, {
      headers: { 'PAYMENT-SIGNATURE': recorder.paymentHeaders[0]! },
    });
    expect(replayed.status).toBe(402);
    expect(paymentRequiredOf(replayed).error).toBe('payment_replayed');
    expect(app.calls.report).toBe(1);
    expect(rpc.sent.length).toBe(sentBefore);
    expect(app.events.at(-1)).toMatchObject({ type: 'replay_rejected', network: SOLANA_DEVNET });
  });

  it('eşzamanlı tekrarlardan yalnızca biri geçer', async () => {
    const headers = await paymentHeaderFor('/report');
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${app.url}/report`, { headers })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 402, 402, 402, 402, 402]);
    expect(app.calls.report).toBe(1);
  });

  it('işleyiciden önce uzlaştırılan route da tekrarı reddeder', async () => {
    const headers = await paymentHeaderFor('/upfront');
    expect((await fetch(`${app.url}/upfront`, { headers })).status).toBe(200);
    const replayed = await fetch(`${app.url}/upfront`, { headers });
    expect(replayed.status).toBe(402);
    // Uzlaştırma işleyiciden önce yapıldığından ret, uzlaştırma makbuzunda bildirilir.
    expect(readPaymentReceipt(replayed)).toMatchObject({ success: false, errorReason: 'payment_replayed' });
    expect(app.calls.upfront).toBe(1);
  });

  it('kullanılmış yük, işleyici hata dönse de yeniden kullanılamaz', async () => {
    const headers = await paymentHeaderFor('/broken');
    expect((await fetch(`${app.url}/broken`, { headers })).status).toBe(500);
    expect((await fetch(`${app.url}/broken`, { headers })).status).toBe(402);
    expect(app.calls.broken).toBe(1);
  });

  it('depo hata verirse istek geçirilmez (fail closed)', async () => {
    await app.close();
    app = await startPaidApp(wallets, rpc, {
      replay: {
        claim: async () => {
          throw new Error('veritabanı yok');
        },
      },
    });
    const headers = await paymentHeaderFor('/report');
    const response = await fetch(`${app.url}/report`, { headers });
    expect(response.status).toBe(402);
    expect(paymentRequiredOf(response).error).toBe('replay_guard_unavailable');
    expect(app.calls.report).toBe(0);
    expect(app.events).toContainEqual(expect.objectContaining({ type: 'replay_guard_error' }));
  });

  it('kayıt ağ kapsamında ve replayTtlSeconds süresince tutulur', async () => {
    const now = Date.parse('2026-10-06T09:00:00Z');
    const claims: { scope: string; id: string; expiresAt: Date; now: Date }[] = [];
    await app.close();
    app = await startPaidApp(wallets, rpc, {
      replay: {
        claim: async (scope, id, expiresAt, at) => {
          claims.push({ scope, id, expiresAt, now: at });
          return true;
        },
      },
      replayTtlSeconds: 600,
      clock: () => now,
    });
    const response = await pay(`${app.url}/report`);
    const body = (await response.json()) as { payment: X402Payment };
    expect(claims).toEqual([
      {
        scope: `x402:${SOLANA_DEVNET}`,
        id: body.payment.fingerprint,
        expiresAt: new Date(now + 600_000),
        now: new Date(now),
      },
    ]);
  });
});

describe('ödeme başlığının doğrulanması', () => {
  it('başka bir alıcıya kurulmuş ödeme kabul edilmez', async () => {
    const other = await startPaidApp({ ...wallets, payTo: (await createWallets()).payTo }, rpc, { replay });
    try {
      const headers = await buildPaymentHeader(`${other.url}/report`, wallets, rpc);
      const response = await fetch(`${app.url}/report`, { headers });
      expect(response.status).toBe(402);
      expect(paymentRequiredOf(response).error).toBe('No matching payment requirements');
      expect(app.calls.report).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('simülasyonu başarısız işlem reddedilir ve tekrar kaydı tüketilmez', async () => {
    rpc.setSimulationError({ InstructionError: [2, { Custom: 1 }] });
    const headers = await paymentHeaderFor('/report');
    const response = await fetch(`${app.url}/report`, { headers });
    expect(response.status).toBe(402);
    expect(paymentRequiredOf(response).error).toBe('invalid_exact_svm_transaction_simulation_failed');
    expect(replay.size()).toBe(0);
    rpc.setSimulationError(null);
    expect((await fetch(`${app.url}/report`, { headers })).status).toBe(200);
  });

  it('bozuk başlık 402 ile reddedilir', async () => {
    const response = await fetch(`${app.url}/report`, { headers: { 'PAYMENT-SIGNATURE': 'e30=' } });
    expect(response.status).toBe(402);
    expect(app.calls.report).toBe(0);
  });

  it('parmak izi işleyicinin gördüğü ödemeyle aynıdır', async () => {
    const headers = await paymentHeaderFor('/report');
    const decoded = JSON.parse(Buffer.from(headers['PAYMENT-SIGNATURE']!, 'base64').toString('utf8'));
    const response = await fetch(`${app.url}/report`, { headers });
    const body = (await response.json()) as { payment: X402Payment };
    expect(body.payment.fingerprint).toBe(paymentFingerprint(decoded));
  });
});
