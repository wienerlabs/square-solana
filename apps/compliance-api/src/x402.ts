// Servisin x402 kurulumu (BE-24): facilitator ADR 0018'e göre (varsayılan kendi facilitator'ımız),
// tekrar korumaları Square'in tek veritabanındaki `replay_guards` tablosunda
// (`@squaresdk/solana-hardening/prisma`); aynı ödeme kimliğiyle gelen tekrarın kayıtlı yanıtı
// `idempotency_records`'ta. compliance-api'nin kendi tabloları BE-25'e kadar ayrı
// veritabanındadır; tekrar koruması ise baştan tek veritabanında tutulur ki diğer servislerle aynı kayıt
// paylaşılsın.
import { createPrismaIdempotencyStore, createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import type { RequestHandler } from 'express';
import type { FacilitatorOptions, X402Event } from '@squaresdk/solana-x402';
import { config } from './config.js';
import { createComplianceX402, parseFeePayerKeypair, type ComplianceX402 } from './middleware/x402.js';
import { logger } from './utils/logger.js';

// db paketi yalnızca ESM `import` koşulunu dışa aktarır; bu servis CommonJS derlendiği için dinamik import.
const databaseReady = import('@squaresdk/solana-db').then(({ createDatabaseClient }) =>
  createDatabaseClient({ connectionString: config.x402.databaseUrl }),
);
const replayStoreReady = databaseReady.then(createPrismaReplayStore);
const idempotencyStoreReady = databaseReady.then(createPrismaIdempotencyStore);

/** Süresi dolan tekrar kayıtları bu aralıkla silinir. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

function logEvent(event: X402Event): void {
  switch (event.type) {
    case 'verified':
      logger.info('x402 payment verified', { payer: event.payment.payer, network: event.payment.network });
      return;
    case 'settled':
      logger.info('x402 payment settled', {
        transaction: event.transaction,
        payer: event.payer,
        network: event.network,
      });
      return;
    case 'replay_rejected':
      logger.warn('x402 payment replay rejected', { fingerprint: event.fingerprint, network: event.network });
      return;
    case 'settle_failed':
      logger.warn('x402 settlement failed', { reason: event.reason, network: event.network });
      return;
    case 'replay_guard_error':
      logger.error('x402 replay guard unavailable', {
        error: event.error instanceof Error ? event.error.message : String(event.error),
      });
      return;
    case 'idempotent_replay':
      logger.info('x402 stored response replayed', { key: event.key, network: event.network });
      return;
    case 'idempotency_error':
      logger.error('x402 idempotency store unavailable', {
        error: event.error instanceof Error ? event.error.message : String(event.error),
      });
      return;
  }
}

async function facilitatorOptions(): Promise<FacilitatorOptions> {
  const { facilitator, network } = config.x402;
  if (facilitator.mode === 'remote') {
    return { mode: 'remote', url: facilitator.url, ...(facilitator.token ? { authToken: facilitator.token } : {}) };
  }
  return {
    mode: 'self',
    feePayer: await parseFeePayerKeypair(facilitator.feePayerKeypair),
    rpcUrls: { [network]: config.solana.rpcUrl },
  };
}

/** Kurulum açılışta başlar (ücret ödeyen anahtarı WebCrypto ile içe aktarılır); hata süreci durdurur. */
export const x402Ready: Promise<ComplianceX402> = Promise.all([
  facilitatorOptions(),
  replayStoreReady,
  idempotencyStoreReady,
]).then(([facilitator, replay, idempotencyStore]) =>
  createComplianceX402({
    facilitator,
    replay,
    idempotency: { store: idempotencyStore, ttlSeconds: config.x402.idempotencyTtlSeconds },
    network: config.x402.network,
    paymentMint: config.x402.paymentMint,
    publisherWallet: config.x402.publisherWallet,
    onEvent: logEvent,
  }),
);

/** Ücretli route ara katmanı; kurulum bitene kadar gelen istek onu bekler. */
export function x402Paywall(priceBaseUnits: number, description: string): RequestHandler {
  const handler = x402Ready.then((x402) => x402.requireX402Payment(priceBaseUnits, description));
  handler.catch(() => undefined);
  return (req, res, next) => {
    handler.then((paywall) => paywall(req, res, next), next);
  };
}

/** Süresi dolan `replay_guards` ve `idempotency_records` satırlarını periyodik siler; durdurma işlevini döner. */
export function purgeExpiredReplayGuards(): () => void {
  const timer = setInterval(() => {
    Promise.all([replayStoreReady, idempotencyStoreReady])
      .then(([replay, idempotency]) =>
        Promise.all([replay.purgeExpired(new Date()), idempotency.purgeExpired(new Date())]),
      )
      .catch((error: unknown) => {
        logger.error('x402 replay guard purge failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, PURGE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
