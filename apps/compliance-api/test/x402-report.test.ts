// Ücretli rapor uç noktasının davranışı (BE-24): x402 v2 akışı `@squaresdk/solana-x402` üzerinden, tekrar
// koruması Postgres'te (`replay_guards`). Modeller ve logger taklit edilir (servisin kendi veritabanı ve
// ortam doğrulaması bu testin konusu değil); Solana RPC'si sahtedir, ödeme resmi istemciyle kurulur.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createPrismaIdempotencyStore, createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { createPayingFetch, readPaymentReceipt, toSolanaNetwork } from '@squaresdk/solana-x402';
import { startFakeSolanaRpc, type FakeSolanaRpc } from '../../../packages/x402/test/solana-rpc.js';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import bs58 from 'bs58';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/models/proof-record.js', () => ({
  getProofRecordsByOperator: vi.fn(async () => ({
    records: [
      {
        payment_id: 'pay_1',
        proof_hash: 'ab'.repeat(32),
        is_compliant: true,
        amount_range_min: 10,
        amount_range_max: 20,
        verified_at: new Date('2026-10-01T00:00:00Z'),
      },
    ],
    total: 1,
  })),
}));
vi.mock('../src/models/attestation.js', () => ({
  getAttestationsByOperator: vi.fn(async () => ({
    attestations: [
      { total_amount_range_min: 10, total_amount_range_max: 20, policy_violations: 0, sanctions_intersections: 0 },
    ],
    total: 1,
  })),
}));

const { createComplianceX402, parseFeePayerKeypair } = await import('../src/middleware/x402.js');
const { createComplianceReportRouter } = await import('../src/routes/compliance-report.js');

const NETWORK = toSolanaNetwork('solana-devnet');
const PRICE = 1_000_000;
const IDEMPOTENCY_TTL_SECONDS = 3_600;

let db: IsolatedDatabase;
let rpc: FakeSolanaRpc;
let server: Server;
let base: string;
let payer: KeyPairSigner;
let feePayer: KeyPairSigner;
let mint: string;
let publisher: string;

beforeAll(async () => {
  [db, rpc] = await Promise.all([startIsolatedDatabase(), startFakeSolanaRpc()]);
  [payer, feePayer] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
  mint = (await generateKeyPairSigner()).address;
  publisher = (await generateKeyPairSigner()).address;
  rpc.addMint(mint, 6);

  const x402 = createComplianceX402({
    facilitator: {
      feePayer,
      rpcUrls: { [NETWORK]: rpc.url },
      limits: { maxComputeUnits: 100_000, maxPriorityFeeMicroLamports: 50_000, maxRequiredSignatures: 2 },
    },
    replay: createPrismaReplayStore(db.client),
    idempotency: { store: createPrismaIdempotencyStore(db.client), ttlSeconds: IDEMPOTENCY_TTL_SECONDS },
    network: NETWORK,
    paymentMint: mint,
    publisherWallet: publisher,
  });
  const app = express();
  app.use(
    '/api/v1/compliance',
    createComplianceReportRouter(x402.requireX402Payment(PRICE, 'Aperture Compliance Report')),
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/compliance/protected-report`;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await rpc?.close();
  await db?.stop();
});

const payingFetch = (record: string[]) =>
  createPayingFetch({
    signer: payer,
    networks: [NETWORK],
    rpcUrl: rpc.url,
    spendControls: { allowedAssets: [{ network: NETWORK, asset: mint }] },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const header = request.headers.get('PAYMENT-SIGNATURE');
      if (header) record.push(header);
      return fetch(request);
    },
  });

describe('GET /api/v1/compliance/protected-report', () => {
  it('operator_id yoksa ödeme istenmeden 400', async () => {
    const response = await fetch(base);
    expect(response.status).toBe(400);
    expect(response.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('ödemesiz istek 402 ve x402 v2 gereksinimi alır (mint, alıcı, taban birim fiyat, CAIP-2 ağ)', async () => {
    const response = await fetch(`${base}?operator_id=op1`);
    expect(response.status).toBe(402);
    const required = JSON.parse(Buffer.from(response.headers.get('PAYMENT-REQUIRED')!, 'base64').toString('utf8'));
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: mint,
      payTo: publisher,
      amount: String(PRICE),
      extra: { feePayer: feePayer.address, paymentFlow: 'upfront' },
    });
    expect(required.resource.description).toBe('Aperture Compliance Report');
  });

  it('eski `x-402-payment` başlığı (zincirdeki imza) artık ödeme sayılmaz', async () => {
    const legacy = Buffer.from(JSON.stringify({ txSignature: '5'.repeat(88), payer: publisher })).toString('base64');
    const response = await fetch(`${base}?operator_id=op1`, { headers: { 'x-402-payment': legacy } });
    expect(response.status).toBe(402);
  });

  it('ödenen rapor uzlaştırma işlemini içerir; yanıt kaybolursa aynı başlık kayıtlı raporu ücretsiz alır', async () => {
    const headers: string[] = [];
    const response = await payingFetch(headers)(`${base}?operator_id=op1`);
    expect(response.status).toBe(200);
    const receipt = readPaymentReceipt(response)!;
    const text = await response.text();
    const body = JSON.parse(text) as { success: boolean; data: { operator_id: string; payment: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.operator_id).toBe('op1');
    expect(body.data.payment).toEqual({
      tx_signature: receipt.transaction,
      payer: payer.address,
      amount: String(PRICE),
      asset: mint,
      network: NETWORK,
    });

    const again = await fetch(`${base}?operator_id=op1`, { headers: { 'PAYMENT-SIGNATURE': headers[0]! } });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(text);
    expect(readPaymentReceipt(again)).toEqual(receipt);
    expect(rpc.sent).toHaveLength(1);
  });

  it('ödeme kimliği olmayan yük ikinci kez kabul edilmez', async () => {
    const client = new x402HTTPClient(
      new x402Client().register(NETWORK, new ExactSvmScheme(payer, { rpcUrl: rpc.url })).setSpendControls(false),
    );
    const required = decodePaymentRequiredHeader(
      (await fetch(`${base}?operator_id=op2`)).headers.get('PAYMENT-REQUIRED')!,
    );
    const headers = client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
    const sent = rpc.sent.length;
    expect((await fetch(`${base}?operator_id=op2`, { headers })).status).toBe(200);
    const replayed = await fetch(`${base}?operator_id=op2`, { headers });
    expect(replayed.status).toBe(402);
    // Uzlaştırma işleyiciden önce: ret uzlaştırma makbuzunda (`PAYMENT-RESPONSE`, success: false).
    expect(readPaymentReceipt(replayed)).toMatchObject({ success: false, errorReason: 'payment_replayed' });
    expect(rpc.sent).toHaveLength(sent + 1);
  });
});

describe('parseFeePayerKeypair', () => {
  it('base58 ve JSON dizi biçimini okur, 64 bayt dışını reddeder', async () => {
    const keypair = Keypair.generate();
    const expected = keypair.publicKey.toBase58();
    expect((await parseFeePayerKeypair(bs58.encode(keypair.secretKey))).address).toBe(expected);
    expect((await parseFeePayerKeypair(JSON.stringify([...keypair.secretKey]))).address).toBe(expected);
    expect(() => parseFeePayerKeypair(bs58.encode(keypair.secretKey.slice(0, 32)))).toThrow(/64 bytes/);
  });
});
