// Kalıcı tekrar koruması gerçek Postgres'te (Testcontainers; Docker gerekir): `@squaresdk/solana-hardening`
// Prisma deposu ve `replay_guards` tablosu. Süreç yeniden başlatması, yeni geçit + yeni facilitator + yeni
// veritabanı istemcisiyle canlandırılır: facilitator'ın bellek içi yinelenen ödeme önbelleği boştur, tekrarı
// yalnızca veritabanındaki kayıt durdurur. Servisin iki örneği de aynı kaydı paylaşır.
import { createDatabaseClient } from '@squaresdk/solana-db';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPayingFetch } from '../src/client.js';
import type { X402Payment } from '../src/gateway.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import type { FakeSolanaRpc } from './solana-rpc.js';
import {
  buildPaymentHeader,
  createWallets,
  paymentRequiredOf,
  recordingFetch,
  startFakeSolanaRpc,
  startPaidApp,
  type Wallets,
} from './helpers.js';

let db: IsolatedDatabase;
let rpc: FakeSolanaRpc;
let wallets: Wallets;

beforeAll(async () => {
  [db, rpc, wallets] = await Promise.all([startIsolatedDatabase(), startFakeSolanaRpc(), createWallets()]);
  rpc.addMint(wallets.mint, 6);
});
afterAll(async () => {
  await rpc?.close();
  await db?.stop();
});

describe('Postgres tekrar koruması', () => {
  it('ödeme yükü süreç yeniden başladıktan sonra da ikinci kez kabul edilmez', async () => {
    const recorder = recordingFetch();
    const pay = createPayingFetch({
      signer: wallets.payer,
      networks: [SOLANA_DEVNET],
      rpcUrl: rpc.url,
      spendControls: { allowedAssets: [{ network: SOLANA_DEVNET, asset: wallets.mint }] },
      fetch: recorder.fetch,
    });

    const first = await startPaidApp(wallets, rpc, { replay: createPrismaReplayStore(db.client) });
    const paid = await pay(`${first.url}/report`);
    expect(paid.status).toBe(200);
    const { payment } = (await paid.json()) as { payment: X402Payment };
    await first.close();

    const rows = await db.client.$queryRaw<{ scope: string; id: string }[]>`SELECT scope, id FROM replay_guards`;
    expect(rows).toEqual([{ scope: `x402:${SOLANA_DEVNET}`, id: payment.fingerprint }]);

    // "Yeniden başlatma": yeni bağlantı havuzu, yeni facilitator (boş yinelenen ödeme önbelleği), yeni geçit.
    const client = createDatabaseClient({ connectionString: db.url });
    const restarted = await startPaidApp(wallets, rpc, { replay: createPrismaReplayStore(client) });
    try {
      const sentBefore = rpc.sent.length;
      const replayed = await fetch(`${restarted.url}/report`, {
        headers: { 'PAYMENT-SIGNATURE': recorder.paymentHeaders[0]! },
      });
      expect(replayed.status).toBe(402);
      expect(paymentRequiredOf(replayed).error).toBe('payment_replayed');
      expect(restarted.calls.report).toBe(0);
      expect(rpc.sent.length).toBe(sentBefore);
    } finally {
      await restarted.close();
      await client.$disconnect();
    }
  });

  it('aynı veritabanını paylaşan iki örnekte eşzamanlı tekrarlardan yalnızca biri geçer', async () => {
    const instances = await Promise.all([
      startPaidApp(wallets, rpc, { replay: createPrismaReplayStore(db.client) }),
      startPaidApp(wallets, rpc, { replay: createPrismaReplayStore(db.client) }),
    ]);
    try {
      const headers = await buildPaymentHeader(`${instances[0].url}/report`, wallets, rpc);
      const responses = await Promise.all(
        Array.from({ length: 8 }, (_, index) => fetch(`${instances[index % 2]!.url}/report`, { headers })),
      );
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      expect(instances[0].calls.report + instances[1].calls.report).toBe(1);
    } finally {
      await Promise.all(instances.map((instance) => instance.close()));
    }
  });
});
