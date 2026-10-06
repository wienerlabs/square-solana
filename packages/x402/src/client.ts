// Ödeyen istemci: resmi `@x402/fetch` sarmalayıcısı + Solana exact şeması. 402 yanıtındaki gereksinimi
// okur, enjekte edilen cüzdan imzalayıcısıyla SPL token aktarımını kısmen imzalar (ücret ödeyen
// facilitator'dır), isteği `PAYMENT-SIGNATURE` başlığıyla tekrarlar. Harcama sınırları resmi istemcinin
// `spendControls`'udur: varsayılan olarak yalnızca tanınan stablecoin'ler ve ödeme başına $1.
import type { TransactionSigner } from '@solana/kit';
import type { SpendControls } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import type { SettleResponse } from '@x402/core/types';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import type { SolanaNetwork } from './networks.js';

export interface PayingFetchOptions {
  /** Ödeyen cüzdan (`@solana/kit` `TransactionSigner`; ör. `KeyPairSigner` ya da cüzdan adaptörü). */
  readonly signer: TransactionSigner;
  /** Ödeme yapılabilecek ağlar; başka ağdaki gereksinim seçilmez. */
  readonly networks: readonly SolanaNetwork[];
  /** Mint bilgisi ve (402 taşımıyorsa) blok hash'i için RPC adresi. */
  readonly rpcUrl: string;
  /** Resmi harcama sınırları; USDC dışı mint'ler `allowedAssets` ile açılır. */
  readonly spendControls?: SpendControls;
  readonly fetch?: typeof globalThis.fetch;
}

export type PayingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function createPayingFetch(options: PayingFetchOptions): PayingFetch {
  if (options.networks.length === 0) throw new Error('ödeme için en az bir ağ gerekir');
  const client = x402Client.fromConfig({
    schemes: options.networks.map((network) => ({
      network,
      client: new ExactSvmScheme(options.signer, { rpcUrl: options.rpcUrl }),
    })),
    ...(options.spendControls ? { spendControls: options.spendControls } : {}),
  });
  return wrapFetchWithPayment(options.fetch ?? globalThis.fetch, client);
}

/** Yanıttaki makbuz (`PAYMENT-RESPONSE`): uzlaştırma işlemi, ağ ve ödeyen. Başlık yoksa `null`. */
export function readPaymentReceipt(response: Pick<Response, 'headers'>): SettleResponse | null {
  const header = response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  return header ? decodePaymentResponseHeader(header) : null;
}
