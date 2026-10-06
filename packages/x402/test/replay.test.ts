// Ödeme yükü kimliği: imzalanan işlem mesajına bağlıdır; zarf alanları ve ücret ödeyen imza yuvası
// kimliği değiştirmez.
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_DEVNET } from '../src/networks.js';
import { paymentFingerprint, replayScope } from '../src/replay.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import { createWallets, startFakeSolanaRpc, type Wallets } from './helpers.js';

let rpc: FakeSolanaRpc;
let wallets: Wallets;
let required: PaymentRequired;
let client: x402Client;

beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
  wallets = await createWallets();
  rpc.addMint(wallets.mint, 6);
  client = new x402Client()
    .register(SOLANA_DEVNET, new ExactSvmScheme(wallets.payer, { rpcUrl: rpc.url }))
    .setSpendControls(false);
  required = {
    x402Version: 2,
    resource: { url: 'https://api.example/report' },
    accepts: [
      {
        scheme: 'exact',
        network: SOLANA_DEVNET,
        asset: wallets.mint,
        amount: '1000',
        payTo: wallets.payTo,
        maxTimeoutSeconds: 60,
        extra: { feePayer: wallets.feePayer.address },
      },
    ],
  };
});
afterAll(async () => {
  await rpc.close();
});

describe('paymentFingerprint', () => {
  it('aynı işlem aynı kimlik; zarf alanları kimliği değiştirmez', async () => {
    const payload = await client.createPaymentPayload(required);
    const fingerprint = paymentFingerprint(payload);
    expect(fingerprint).toMatch(/^svm:[0-9a-f]{64}$/);
    const rewrapped: PaymentPayload = {
      ...payload,
      resource: { url: 'https://başka.example/' },
      extensions: { bazaar: { x: 1 } },
    };
    expect(paymentFingerprint(rewrapped)).toBe(fingerprint);
  });

  it('ücret ödeyen imza yuvasını değiştirmek kimliği değiştirmez', async () => {
    const payload = await client.createPaymentPayload(required);
    const wire = Buffer.from((payload.payload as { transaction: string }).transaction, 'base64');
    // Tel biçimi: imza sayısı (shortvec, 1 bayt) + 64 baytlık imzalar; ilk yuva ücret ödeyenindir.
    crypto.getRandomValues(wire.subarray(1, 65));
    const tampered = { ...payload, payload: { transaction: wire.toString('base64') } };
    expect(paymentFingerprint(tampered)).toBe(paymentFingerprint(payload));
  });

  it('yeni ödeme yeni kimlik', async () => {
    const first = await client.createPaymentPayload(required);
    const second = await client.createPaymentPayload(required);
    expect(paymentFingerprint(second)).not.toBe(paymentFingerprint(first));
  });

  it('işlem taşımayan yükte kanonik JSON özeti (anahtar sırasından bağımsız)', () => {
    const accepted = required.accepts[0]!;
    const a = paymentFingerprint({ accepted, payload: { b: [1, { y: 2, x: 1 }], a: 'v', skip: undefined } });
    const b = paymentFingerprint({ accepted, payload: { a: 'v', b: [1, { x: 1, y: 2 }] } });
    expect(a).toMatch(/^json:[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(paymentFingerprint({ accepted, payload: { a: 'w', b: [1, { x: 1, y: 2 }] } })).not.toBe(a);
  });

  it('çözülemeyen işlem metni JSON özetine düşer', () => {
    const accepted = required.accepts[0]!;
    expect(paymentFingerprint({ accepted, payload: { transaction: 'bozuk' } })).toMatch(/^json:/);
  });

  it('kapsam ağa göredir', () => {
    expect(replayScope(SOLANA_DEVNET)).toBe(`x402:${SOLANA_DEVNET}`);
  });
});
