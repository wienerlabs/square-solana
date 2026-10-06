// Uçtan uca devnet koşusu (BE-24 kabul kriteri): ücretli uç devnet'te gerçek USDC ödemesiyle açılır. Kendi
// facilitator'ımız işlemi devnet'e gönderir, tekrar koruması Postgres'tedir (`replay_guards`). Yalnızca
// `X402_E2E_*` ortamıyla çalışır (anahtarlar repoda tutulmaz):
//   X402_E2E_PAYER      ödeyen keypair'i (devnet Circle USDC'si var)
//   X402_E2E_FEE_PAYER  facilitator'ın ücret ödeyeni (yalnızca SOL; alıcıdan ayrı)
//   X402_E2E_PAY_TO     alıcı adres; USDC hesabı (ATA) açık olmalı
//   X402_E2E_REPORT     isteğe bağlı: koşunun imzalarının yazılacağı JSON dosyası
// RPC `scripts/deploy/networks/devnet.json`'dandır. Tekrar koruması ve idempotent yanıt testin Postgres'indedir
// (`replay_guards`, `idempotency_records`).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createPrismaIdempotencyStore, createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import { createPayingFetch, readPaymentReceipt } from '../src/client.js';
import { createFacilitatorClient } from '../src/facilitator.js';
import { createX402Gateway, getX402Payment, type X402Event } from '../src/gateway.js';
import { SOLANA_DEVNET, usdcMint } from '../src/networks.js';
import { listen, paymentRequiredOf, recordingFetch, type Listening } from './helpers.js';

const ENV = {
  payer: process.env['X402_E2E_PAYER'],
  feePayer: process.env['X402_E2E_FEE_PAYER'],
  payTo: process.env['X402_E2E_PAY_TO'],
  report: process.env['X402_E2E_REPORT'],
};
const ENABLED = Boolean(ENV.payer && ENV.feePayer && ENV.payTo);

/** 0,01 USDC (taban birim); resmi istemcinin varsayılan harcama sınırının ($1) altında. */
const PRICE_BASE_UNITS = 10_000n;
const IDEMPOTENCY_TTL_SECONDS = 3_600;

const signer = (path: string) =>
  createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));

async function rpcCall<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? 'yanıt yok'}`);
  return body.result;
}

/** Sahibin mint'teki token hesaplarının toplam bakiyesi (taban birim). */
async function tokenBalance(url: string, owner: string, mint: string): Promise<bigint> {
  const result = await rpcCall<{
    value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
  }>(url, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return result.value.reduce((sum, item) => sum + BigInt(item.account.data.parsed.info.tokenAmount.amount), 0n);
}

describe.skipIf(!ENABLED)('devnet: ücretli uç gerçek USDC ödemesiyle açılır', () => {
  let rpcUrl: string;
  let mint: string;
  let payer: KeyPairSigner;
  let db: IsolatedDatabase;
  let server: Listening;
  const events: X402Event[] = [];
  const signatures: Record<string, string> = {};

  beforeAll(async () => {
    rpcUrl = (loadNetwork(fileURLToPath(new URL('../../../', import.meta.url)), 'devnet') as { rpc: string }).rpc;
    mint = usdcMint(SOLANA_DEVNET);
    payer = await signer(ENV.payer!);
    const feePayer = await signer(ENV.feePayer!);
    db = await startIsolatedDatabase();
    const gateway = createX402Gateway({
      facilitator: createFacilitatorClient({ feePayer, rpcUrls: { [SOLANA_DEVNET]: rpcUrl } }),
      networks: [SOLANA_DEVNET],
      replay: createPrismaReplayStore(db.client),
      idempotency: { store: createPrismaIdempotencyStore(db.client), ttlSeconds: IDEMPOTENCY_TTL_SECONDS },
      onEvent: (event) => events.push(event),
    });
    const app = express();
    app.get(
      '/report',
      gateway.paidRoute({
        price: { amount: PRICE_BASE_UNITS.toString(), asset: mint },
        payTo: ENV.payTo!,
        network: SOLANA_DEVNET,
        description: 'devnet e2e raporu',
      }),
      (_req, res) => {
        res.json({ ok: true, payment: getX402Payment(res) });
      },
    );
    server = await listen(app);
  }, 180_000);

  afterAll(async () => {
    if (ENV.report) writeFileSync(ENV.report, `${JSON.stringify(signatures, null, 2)}\n`);
    await server?.close();
    await db?.stop();
  });

  const count = (type: X402Event['type']) => events.filter((event) => event.type === type).length;

  it('402 → ödeme → 200 ve makbuz; USDC alıcıya geçer; yanıt kaybolursa aynı başlık ikinci kez ödetmez', async () => {
    const url = `${server.url}/report`;
    const unpaid = await fetch(url);
    expect(unpaid.status).toBe(402);
    const [requirement] = paymentRequiredOf(unpaid).accepts;
    expect(requirement).toMatchObject({ network: SOLANA_DEVNET, asset: mint, payTo: ENV.payTo });

    const before = await tokenBalance(rpcUrl, ENV.payTo!, mint);
    const recording = recordingFetch();
    const pay = createPayingFetch({ signer: payer, networks: [SOLANA_DEVNET], rpcUrl, fetch: recording.fetch });
    const paid = await pay(url);
    expect(paid.status).toBe(200);
    const text = await paid.text();
    expect(JSON.parse(text)).toMatchObject({ ok: true, payment: { payer: payer.address } });
    const receipt = readPaymentReceipt(paid);
    expect(receipt).toMatchObject({ success: true, network: SOLANA_DEVNET, payer: payer.address });
    signatures['settle'] = receipt!.transaction;

    const statuses = await rpcCall<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>(
      rpcUrl,
      'getSignatureStatuses',
      [[receipt!.transaction], { searchTransactionHistory: true }],
    );
    expect(statuses.value[0]).toMatchObject({ err: null });
    expect(['confirmed', 'finalized']).toContain(statuses.value[0]!.confirmationStatus);
    expect((await tokenBalance(rpcUrl, ENV.payTo!, mint)) - before).toBe(PRICE_BASE_UNITS);

    // Yanıt yolda kayboldu: istemci aynı başlığı (aynı ödeme kimliği) yeniden gönderir.
    expect(recording.paymentHeaders).toHaveLength(1);
    const again = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': recording.paymentHeaders[0]! } });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(text);
    expect(readPaymentReceipt(again)).toEqual(receipt);
    expect(count('idempotent_replay')).toBe(1);
    expect(count('settled')).toBe(1);
    expect((await tokenBalance(rpcUrl, ENV.payTo!, mint)) - before).toBe(PRICE_BASE_UNITS);
  }, 180_000);

  it('kimliksiz aynı başlıkla eşzamanlı iki istekten biri geçer; uzlaşmış ödeme yeniden kullanılamaz', async () => {
    const url = `${server.url}/report`;
    const required = paymentRequiredOf(await fetch(url));
    const client = new x402HTTPClient(new x402Client().register(SOLANA_DEVNET, new ExactSvmScheme(payer, { rpcUrl })));
    const headers = client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    const settledBefore = count('settled');
    const responses = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
    const accepted = responses.find((response) => response.status === 200)!;
    signatures['concurrent'] = readPaymentReceipt(accepted)!.transaction;
    expect(count('replay_rejected')).toBe(1);
    expect(count('settled')).toBe(settledBefore + 1);

    // Uzlaşmış işlemin tekrarı: facilitator'ın doğrulaması (simülasyon) işlenmiş işlemi reddeder.
    const replayed = await fetch(url, { headers });
    expect(replayed.status).toBe(402);
    expect(paymentRequiredOf(replayed).error).toBeTruthy();
    expect(count('settled')).toBe(settledBefore + 1);
  }, 180_000);
});
