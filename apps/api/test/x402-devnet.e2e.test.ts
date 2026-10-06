// Geliştirici portalının yüzeyi devnet'te (FE-22 kabul kriterleri): API anahtarı portalın uçlarıyla oluşturulur ve
// iptal edilir; ücretli uç nokta tanımı API'de açılır, geliştiricinin sunucusu (`paidRouteFromDefinition`) tanımı
// `x402:serve` anahtarıyla okur, ödemeyi gerçek devnet USDC'siyle kendi facilitator'ı üzerinden uzlaştırır ve
// bildirir; kullanım sayacı ödemeyi gösterir. Pasifleştirilen tanım 503, silinen 404 alır; iptal edilen anahtar
// tanımı okuyamaz. Yalnızca `X402_PORTAL_E2E_*` ortamıyla çalışır (anahtarlar repoda tutulmaz):
//   X402_PORTAL_E2E_DEVELOPER  geliştiricinin cüzdanı (portal oturumu; SOL ya da token gerekmez)
//   X402_PORTAL_E2E_PAYER      ödeyen keypair'i (devnet Circle USDC'si var)
//   X402_PORTAL_E2E_FEE_PAYER  geliştiricinin facilitator'ının ücret ödeyeni (yalnızca SOL; alıcıdan ayrı)
//   X402_PORTAL_E2E_PAY_TO     alıcı adres; USDC hesabı (ATA) açık olmalı
//   X402_PORTAL_E2E_REPORT     isteğe bağlı: koşunun kaydının yazılacağı JSON dosyası
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { Keypair } from '@solana/web3.js';
import { createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import {
  SOLANA_DEVNET,
  createFacilitatorClient,
  createPayingFetch,
  createX402Gateway,
  paidRouteFromDefinition,
  readPaymentReceipt,
  usdcMint,
} from '@squaresdk/solana-x402';
import express from 'express';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import { loadOpenApi } from '../src/openapi.js';
import { login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import type { Wallet } from './fixtures/world.js';

const ENV = {
  developer: process.env['X402_PORTAL_E2E_DEVELOPER'],
  payer: process.env['X402_PORTAL_E2E_PAYER'],
  feePayer: process.env['X402_PORTAL_E2E_FEE_PAYER'],
  payTo: process.env['X402_PORTAL_E2E_PAY_TO'],
  report: process.env['X402_PORTAL_E2E_REPORT'],
};
const ENABLED = Boolean(ENV.developer && ENV.payer && ENV.feePayer && ENV.payTo);

/** 0,01 USDC (taban birim); resmi istemcinin varsayılan harcama sınırının ($1) altında. */
const PRICE = '10000';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const secret = (path: string) => Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
const walletOf = (path: string): Wallet => {
  const keypair = Keypair.fromSecretKey(secret(path));
  return { keypair, address: keypair.publicKey.toBase58() };
};

describe.skipIf(!ENABLED)('devnet: geliştirici portalı (anahtar, ücretli uç nokta, kullanım)', () => {
  let stack: Stack;
  let rpcUrl: string;
  const record: Record<string, unknown> = {};

  beforeAll(async () => {
    rpcUrl = (loadNetwork(ROOT, 'devnet') as { rpc: string }).rpc;
    stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
    await truncate(stack.db);
  }, 120_000);

  afterAll(async () => {
    if (ENV.report) writeFileSync(ENV.report, `${JSON.stringify(record, null, 2)}\n`);
    await stack?.close();
  });

  it('anahtar oluşturulur → tanım → 402 → gerçek ödeme → 200 → kullanım → pasif / silme → anahtar iptali', async () => {
    const developer = walletOf(ENV.developer!);
    const session = stack.api({ session: await login(stack.api(), developer) });
    const mint = usdcMint(SOLANA_DEVNET);

    // Portalın anahtar uçları: sır yalnızca oluşturma yanıtında döner.
    const createdKey = await session.createApiKey({ label: 'x402 sunucusu', scopes: ['x402:serve'] });
    if (!createdKey.success) throw new Error(createdKey.error.message);
    expect(createdKey.data.secret).toMatch(/^sqk_/);
    const listed = await session.listApiKeys();
    expect(listed.success && listed.data.map((key) => key.id)).toContain(createdKey.data.apiKey.id);

    const created = await session.createX402Endpoint({
      name: 'Devnet raporu',
      path: '/v1/devnet-report',
      description: 'FE-22 devnet kabulü',
      amount: PRICE,
      mint,
      network: SOLANA_DEVNET,
      payTo: ENV.payTo!,
      enabled: true,
    });
    if (!created.success) throw new Error(created.error.message);
    const endpoint = created.data;

    const square = stack.api({ apiKey: createdKey.data.secret });
    const errors: unknown[] = [];
    const gateway = createX402Gateway({
      facilitator: createFacilitatorClient({
        feePayer: await createKeyPairSignerFromBytes(secret(ENV.feePayer!)),
        rpcUrls: { [SOLANA_DEVNET]: rpcUrl },
      }),
      replay: createPrismaReplayStore(stack.db),
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
      expect((await fetch(url)).status).toBe(402);

      const pay = createPayingFetch({
        signer: await createKeyPairSignerFromBytes(secret(ENV.payer!)),
        networks: [SOLANA_DEVNET],
        rpcUrl,
      });
      const paid = await pay(url);
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ report: 'ok' });
      const receipt = readPaymentReceipt(paid)!;
      expect(receipt).toMatchObject({ success: true, network: SOLANA_DEVNET });
      record['settle'] = receipt.transaction;

      await expect
        .poll(
          async () => {
            const usage = await session.getX402EndpointUsage(endpoint.id);
            return usage.success ? usage.data.payments : -1;
          },
          { timeout: 30_000, interval: 500 },
        )
        .toBe(1);
      const usage = await session.getX402EndpointUsage(endpoint.id);
      expect(usage).toMatchObject({
        data: {
          totals: [{ network: SOLANA_DEVNET, asset: mint, amount: PRICE, payments: 1 }],
          recent: [{ transaction: receipt.transaction, payTo: ENV.payTo }],
        },
      });
      record['usage'] = usage.success ? usage.data.totals : null;

      await session.updateX402Endpoint(endpoint.id, { enabled: false });
      expect((await fetch(url)).status).toBe(503);
      await session.deleteX402Endpoint(endpoint.id);
      expect((await fetch(url)).status).toBe(404);
      expect(served).toBe(1);
      expect(errors).toEqual([]);

      // İptal edilen anahtar tanımı okuyamaz.
      await session.deleteApiKey(createdKey.data.apiKey.id);
      expect(await square.getX402Endpoint(endpoint.id)).toMatchObject({ error: { code: 'unauthorized' } });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }, 300_000);
});
