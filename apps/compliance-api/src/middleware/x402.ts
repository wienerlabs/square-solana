// x402 ödeme ara katmanı: `@squaresdk/solana-x402`'ye (BE-24) delege eder. Aperture'ün özel uygulaması
// (`x-402-payment` başlığında zincirde önceden gönderilmiş işlemin imzası, RPC'den yalnızca varlık ve hata
// denetimi) kaldırıldı: tutar, mint ve alıcı denetlenmiyordu, aynı imza sınırsız tekrar kullanılabiliyordu.
// Şimdi x402 v2: 402 + `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE` ile kısmen imzalı SPL aktarımı, resmi exact
// şemasıyla doğrulama ve uzlaştırma, `PAYMENT-RESPONSE` makbuzu ve Postgres'te kalıcı tekrar koruması.
// Uzlaştırma işleyiciden önce yapılır (`before-handler`): rapor işlem imzasını içerir. Yanıt yolda kaybolursa
// aynı ödeme kimliğiyle gelen tekrar kayıtlı raporu ikinci kez ücret alınmadan alır (`idempotency`).
import type { RequestHandler } from 'express';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import bs58 from 'bs58';
import {
  createFacilitatorClient,
  createX402Gateway,
  type FacilitatorOptions,
  type IdempotencyOptions,
  type ReplayStore,
  type SolanaNetwork,
  type X402Event,
} from '@squaresdk/solana-x402';

export { getX402Payment, type X402Payment } from '@squaresdk/solana-x402';

export interface ComplianceX402Options {
  readonly facilitator: FacilitatorOptions;
  readonly replay: ReplayStore;
  readonly idempotency: IdempotencyOptions;
  readonly network: SolanaNetwork;
  readonly paymentMint: string;
  readonly publisherWallet: string;
  readonly onEvent?: (event: X402Event) => void;
}

export interface ComplianceX402 {
  /** Fiyat ödeme mint'inin taban biriminde. */
  requireX402Payment(priceBaseUnits: number, description: string): RequestHandler;
}

export function createComplianceX402(options: ComplianceX402Options): ComplianceX402 {
  const gateway = createX402Gateway({
    facilitator: createFacilitatorClient(options.facilitator),
    replay: options.replay,
    idempotency: options.idempotency,
    networks: [options.network],
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  return {
    requireX402Payment: (priceBaseUnits, description) =>
      gateway.paidRoute({
        price: { amount: String(priceBaseUnits), asset: options.paymentMint },
        payTo: options.publisherWallet,
        network: options.network,
        description,
        settle: 'before-handler',
        // Ara katman Express 4 tiplerine göre yazılı; servis `@types/express` 5 kullanıyor (çalışma anı Express 4).
      }) as unknown as RequestHandler,
  };
}

/** Ücret ödeyen anahtar çifti: base58 ya da JSON dizi, 64 bayt (`MPP_AUTHORITY_KEYPAIR_BASE58` ile aynı biçim). */
export function parseFeePayerKeypair(raw: string) {
  const trimmed = raw.trim();
  const bytes = trimmed.startsWith('[') ? new Uint8Array(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
  if (bytes.length !== 64) throw new Error(`X402_FEE_PAYER_KEYPAIR must decode to 64 bytes, got ${bytes.length}`);
  return createKeyPairSignerFromBytes(bytes);
}
