// Test fikstürleri: bellek içi tekrar deposu, sahte RPC'li kendi facilitator'ımız, anahtarları çalışma
// anında üretilen cüzdanlar ve Express uygulamasını rastgele portta açan yardımcı.
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired } from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import express, { type Express } from 'express';
import { createFacilitatorClient } from '../src/facilitator.js';
import { createX402Gateway, getX402Payment, type X402Event, type X402GatewayOptions } from '../src/gateway.js';
import { SOLANA_DEVNET } from '../src/networks.js';
import type { ReplayStore } from '../src/replay.js';
import { startFakeSolanaRpc, type FakeSolanaRpc } from './solana-rpc.js';

export function memoryReplayStore(): ReplayStore & { size(): number } {
  const seen = new Map<string, number>();
  return {
    async claim(scope, id, expiresAt, now) {
      const key = `${scope}\u0000${id}`;
      const until = seen.get(key);
      if (until !== undefined && until > now.getTime()) return false;
      seen.set(key, expiresAt.getTime());
      return true;
    },
    size: () => seen.size,
  };
}

export interface Wallets {
  readonly feePayer: KeyPairSigner;
  readonly payer: KeyPairSigner;
  readonly payTo: string;
  readonly mint: string;
}

export async function createWallets(): Promise<Wallets> {
  const [feePayer, payer, receiver, mint] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
  return { feePayer, payer, payTo: receiver.address, mint: mint.address };
}

export interface Listening {
  readonly url: string;
  close(): Promise<void>;
}

export async function listen(app: Express): Promise<Listening> {
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export const PRICE_BASE_UNITS = '250000';

export interface PaidApp extends Listening {
  readonly events: X402Event[];
  /** İşleyicinin kaç kez çalıştığı (route adına göre). */
  readonly calls: { report: number; upfront: number; broken: number; cookie: number; locals: number };
}

/**
 * Ücretli beş route'lu uygulama: `/report` (uzlaştırma işleyiciden sonra), `/upfront` (önce), `/cookie`
 * (işleyici başlık koyar), `/locals` (işleyici `res.locals`'ı döner) ve `/broken` (işleyici 500 döner). Yanıt
 * gövdesi işleyicinin gördüğü ödeme bilgisidir.
 */
export async function startPaidApp(
  wallets: Wallets,
  rpc: FakeSolanaRpc,
  overrides: Partial<X402GatewayOptions> & Pick<X402GatewayOptions, 'replay'>,
): Promise<PaidApp> {
  const events: X402Event[] = [];
  const calls = { report: 0, upfront: 0, broken: 0, cookie: 0, locals: 0 };
  const gateway = createX402Gateway({
    facilitator: createFacilitatorClient({ feePayer: wallets.feePayer, rpcUrls: { [SOLANA_DEVNET]: rpc.url } }),
    networks: [SOLANA_DEVNET],
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  const price = { amount: PRICE_BASE_UNITS, asset: wallets.mint };
  const app = express();
  app.get(
    '/report',
    gateway.paidRoute({ price, payTo: wallets.payTo, network: SOLANA_DEVNET, description: 'rapor' }),
    (_req, res) => {
      calls.report += 1;
      res.json({ ok: true, payment: getX402Payment(res) });
    },
  );
  app.get(
    '/upfront',
    gateway.paidRoute({ price, payTo: wallets.payTo, network: SOLANA_DEVNET, settle: 'before-handler' }),
    (_req, res) => {
      calls.upfront += 1;
      res.json({ ok: true, payment: getX402Payment(res) });
    },
  );
  app.use('/cookie', (_req, res, next) => {
    res.cookie('visitor', 'ziyaretci-1').set('Link', '</yardim>; rel="help"');
    next();
  });
  app.get('/cookie', gateway.paidRoute({ price, payTo: wallets.payTo, network: SOLANA_DEVNET }), (_req, res) => {
    calls.cookie += 1;
    res.cookie('session', 'paid-content');
    res.set('Link', '</files/paid-report.pdf>').set('X-Report-Id', 'rapor-7').set('ETag', '"paid-etag"');
    res.set('Date', 'Wed, 01 Jan 2020 00:00:00 GMT');
    res.json({ ok: true, report: 'ücretli içerik' });
  });
  app.get(
    '/locals',
    gateway.paidRoute({ price, payTo: wallets.payTo, network: SOLANA_DEVNET, onSettled: () => undefined }),
    (_req, res) => {
      calls.locals += 1;
      res.json(structuredClone(res.locals));
    },
  );
  app.get('/broken', gateway.paidRoute({ price, payTo: wallets.payTo, network: SOLANA_DEVNET }), (_req, res) => {
    calls.broken += 1;
    res.status(500).json({ ok: false });
  });
  const listening = await listen(app);
  return { ...listening, events, calls };
}

export function paymentRequiredOf(response: Response): PaymentRequired {
  const header = response.headers.get('PAYMENT-REQUIRED');
  if (!header) throw new Error(`PAYMENT-REQUIRED başlığı yok (durum ${response.status})`);
  return decodePaymentRequiredHeader(header);
}

/** Gereksinimden ödeme başlığını resmi istemciyle kurar (ödeyen fetch'i atlayarak; tekrar testleri için). */
export async function buildPaymentHeader(
  url: string,
  wallets: Wallets,
  rpc: FakeSolanaRpc,
): Promise<Record<string, string>> {
  const required = paymentRequiredOf(await fetch(url));
  const client = new x402HTTPClient(
    new x402Client()
      .register(SOLANA_DEVNET, new ExactSvmScheme(wallets.payer, { rpcUrl: rpc.url }))
      .setSpendControls(false),
  );
  return client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

/** Ödeyen fetch'in gönderdiği ödeme başlıklarını kaydeden fetch. */
export function recordingFetch(): { fetch: typeof globalThis.fetch; paymentHeaders: string[] } {
  const paymentHeaders: string[] = [];
  return {
    paymentHeaders,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const header = request.headers.get('PAYMENT-SIGNATURE');
      if (header) paymentHeaders.push(header);
      return globalThis.fetch(request);
    },
  };
}

export { startFakeSolanaRpc };
