// Ödeme kimliğiyle idempotent yanıt (Covenant C-036): gerçek Postgres'te (Testcontainers; Docker gerekir)
// `@squaresdk/solana-hardening`'in `idempotency_records` deposu. Kayıtlı yanıt ikinci kez ücret alınmadan
// döner; kimlik başka bir ödemeyle kullanılamaz; uzlaştırılmayan yanıt saklanmaz.
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createPrismaIdempotencyStore, createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { x402Client, x402HTTPClient, type ClientExtension, type SpendControls } from '@x402/core/client';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import { PAYMENT_IDENTIFIER, extractPaymentIdentifier } from '@x402/extensions/payment-identifier';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPayingFetch, readPaymentReceipt } from '../src/client.js';
import type { PaymentResponseStore } from '../src/idempotent.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import {
  createWallets,
  memoryReplayStore,
  paymentRequiredOf,
  recordingFetch,
  startFakeSolanaRpc,
  startPaidApp,
  type PaidApp,
  type Wallets,
} from './helpers.js';

const TTL_SECONDS = 3_600;

let db: IsolatedDatabase;
let rpc: FakeSolanaRpc;
let wallets: Wallets;
let app: PaidApp;

beforeAll(async () => {
  [db, rpc, wallets] = await Promise.all([startIsolatedDatabase(), startFakeSolanaRpc(), createWallets()]);
  rpc.addMint(wallets.mint, 6);
});
beforeEach(async () => {
  await app?.close();
  app = await startPaidApp(wallets, rpc, {
    replay: createPrismaReplayStore(db.client),
    idempotency: { store: createPrismaIdempotencyStore(db.client), ttlSeconds: TTL_SECONDS },
  });
});
afterAll(async () => {
  await app?.close();
  await rpc?.close();
  await db?.stop();
});

const spend = (): SpendControls => ({ allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint }] });

/** Verilen kimlikle ödeme başlığı kurar (ödeyen fetch'i atlayarak). */
async function headerWithId(url: string, id: string): Promise<Record<string, string>> {
  const fixedId: ClientExtension = {
    key: PAYMENT_IDENTIFIER,
    enrichPaymentPayload: async (payload, required) => ({
      ...payload,
      extensions: {
        ...required.extensions,
        [PAYMENT_IDENTIFIER]: {
          ...(required.extensions?.[PAYMENT_IDENTIFIER] as object),
          info: { required: false, id },
        },
      },
    }),
  };
  const client = new x402HTTPClient(
    new x402Client()
      .register(SOLANA_DEVNET, new ExactSvmScheme(wallets.payer, { rpcUrl: rpc.url }))
      .setSpendControls(false)
      .registerExtension(fixedId),
  );
  return client.encodePaymentSignatureHeader(await client.createPaymentPayload(paymentRequiredOf(await fetch(url))));
}

const count = (type: string) => app.events.filter((event) => event.type === type).length;

describe('ödeme kimliğiyle idempotent yanıt', () => {
  it('402 uzantıyı duyurur; ödeyen fetch yüke kimlik koyar', async () => {
    const required = paymentRequiredOf(await fetch(`${app.url}/report`));
    expect(required.extensions?.[PAYMENT_IDENTIFIER]).toMatchObject({ info: { required: false } });

    const recorder = recordingFetch();
    const pay = createPayingFetch({
      signer: wallets.payer,
      networks: [SOLANA_DEVNET],
      rpcUrl: rpc.url,
      spendControls: spend(),
      fetch: recorder.fetch,
    });
    expect((await pay(`${app.url}/report`)).status).toBe(200);
    expect(extractPaymentIdentifier(decodePaymentSignatureHeader(recorder.paymentHeaders[0]!))).toMatch(/^pay_/);
  });

  it('aynı kimlik, yük ve istek kayıtlı yanıtı alır: işleyici ve uzlaştırma bir kez', async () => {
    const url = `${app.url}/report`;
    const headers = await headerWithId(url, 'pay_lost_response_0001');
    const first = await fetch(url, { headers });
    expect(first.status).toBe(200);
    const sent = rpc.sent.length;

    const again = await fetch(url, { headers });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(await first.text());
    expect(readPaymentReceipt(again)).toEqual(readPaymentReceipt(first));
    expect(again.headers.get('content-type')).toBe(first.headers.get('content-type'));
    expect(app.calls.report).toBe(1);
    expect(rpc.sent.length).toBe(sent);
    expect(count('settled')).toBe(1);
    expect(count('idempotent_replay')).toBe(1);
  });

  it('kimlik başka bir ödemeyle ya da başka bir route ile kullanılamaz', async () => {
    const id = 'pay_reused_identifier_01';
    expect((await fetch(`${app.url}/report`, { headers: await headerWithId(`${app.url}/report`, id) })).status).toBe(
      200,
    );
    const other = await fetch(`${app.url}/report`, { headers: await headerWithId(`${app.url}/report`, id) });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: 'payment_identifier_conflict' });
    expect(app.calls.report).toBe(1);
  });

  it('uzlaştırılmayan yanıt saklanmaz; aynı yük tekrar koruması nedeniyle yeniden kullanılamaz', async () => {
    const url = `${app.url}/broken`;
    const headers = await headerWithId(url, 'pay_handler_failed_001');
    expect((await fetch(url, { headers })).status).toBe(500);
    const rows = await db.client.$queryRaw<{ key: string }[]>`
      SELECT key FROM idempotency_records WHERE key = 'pay_handler_failed_001'`;
    expect(rows).toEqual([]);
    const retried = await fetch(url, { headers });
    expect(retried.status).toBe(402);
    expect(count('replay_rejected')).toBe(1);
    expect(count('settled')).toBe(0);
  });

  it('geçersiz kimlik 400; kimliksiz yük olağan akıştan geçer', async () => {
    const invalid = await fetch(`${app.url}/report`, { headers: await headerWithId(`${app.url}/report`, 'kısa') });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid_payment_identifier' });

    const client = new x402HTTPClient(
      new x402Client()
        .register(SOLANA_DEVNET, new ExactSvmScheme(wallets.payer, { rpcUrl: rpc.url }))
        .setSpendControls(false),
    );
    const required = paymentRequiredOf(await fetch(`${app.url}/report`));
    const payload = await client.createPaymentPayload({ ...required, extensions: {} });
    const plain = await fetch(`${app.url}/report`, { headers: client.encodePaymentSignatureHeader(payload) });
    expect(plain.status).toBe(200);
    expect(count('idempotent_replay')).toBe(0);
  });

  it('bozuk ödeme başlığını resmi ara katman reddeder', async () => {
    const broken = await fetch(`${app.url}/report`, { headers: { 'PAYMENT-SIGNATURE': 'bozuk' } });
    expect(broken.status).toBe(402);
  });
});

describe('depo hataları', () => {
  const failing = (fail: 'begin' | 'complete'): PaymentResponseStore => ({
    begin: async () => {
      if (fail === 'begin') throw new Error('veritabanı yok');
      return { state: 'started' };
    },
    complete: async () => {
      throw new Error('yazılamadı');
    },
    abandon: async () => undefined,
  });

  it('kimlik ayrılamazsa istek geçirilmez (503); kayıt yazılamazsa yanıt yine döner ve olay üretilir', async () => {
    for (const fail of ['begin', 'complete'] as const) {
      const local = await startPaidApp(wallets, rpc, {
        replay: memoryReplayStore(),
        idempotency: { store: failing(fail), ttlSeconds: TTL_SECONDS },
      });
      try {
        const url = `${local.url}/report`;
        const response = await fetch(url, { headers: await headerWithId(url, `pay_store_${fail}_failure`) });
        expect(response.status).toBe(fail === 'begin' ? 503 : 200);
        await new Promise((resolve) => setImmediate(resolve));
        expect(local.events.filter((event) => event.type === 'idempotency_error')).toHaveLength(1);
      } finally {
        await local.close();
      }
    }
  });

  it('süresiz ya da geçersiz ttl reddedilir', async () => {
    await expect(
      startPaidApp(wallets, rpc, {
        replay: memoryReplayStore(),
        idempotency: { store: failing('begin'), ttlSeconds: 0 },
      }),
    ).rejects.toThrow(/ttlSeconds/);
  });
});
