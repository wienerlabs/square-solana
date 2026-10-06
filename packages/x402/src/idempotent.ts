// Ödeme kimliğiyle idempotent yanıt (Covenant'ın C-036'sının karşılığı). İstemci ödeme yüküne resmi
// `payment-identifier` uzantısıyla (`@x402/extensions`) bir kimlik koyar. Uzlaştırılan yanıt bu kimlikle saklanır.
// Aynı kimlik aynı yük ve aynı istekle yeniden gelirse (ör. yanıt yolda kayboldu) kayıtlı yanıt döner: işleyici
// çalışmaz, ikinci kez ücret alınmaz.
// - Kimlik başka bir yük ya da istekle gelirse 409 `payment_identifier_conflict`.
// - Aynı kimlikli istek sürerken gelen tekrar 409 `payment_in_progress`.
// - Uzlaştırılmayan yanıt (işleyici hatası, uzlaştırma hatası) saklanmaz, kimlik bırakılır.
// - Depo hatasında istek geçirilmez (503).
// Depo arayüzü `@squaresdk/solana-hardening`'in `IdempotencyStore`'uyla yapısal olarak aynıdır: servis
// `createPrismaIdempotencyStore(client)` (`idempotency_records` tablosu) verir.
import { createHash } from 'node:crypto';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  extractAndValidatePaymentIdentifier,
} from '@x402/extensions/payment-identifier';
import type { Request, RequestHandler, Response } from 'express';
import { paymentFingerprint } from './replay.js';

export type PaymentResponseBegin =
  | { readonly state: 'started' }
  | { readonly state: 'in_progress' }
  | { readonly state: 'mismatch' }
  | { readonly state: 'completed'; readonly status: number; readonly body: unknown };

export interface PaymentResponseStore {
  begin(scope: string, key: string, requestHash: string, expiresAt: Date, now: Date): Promise<PaymentResponseBegin>;
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  abandon(scope: string, key: string): Promise<void>;
}

export interface IdempotencyOptions {
  /** Servislerde `createPrismaIdempotencyStore(client)` (`idempotency_records`). */
  readonly store: PaymentResponseStore;
  /** Kayıtlı yanıtın tutulduğu süre (saniye). */
  readonly ttlSeconds: number;
}

/** Saklanan yanıt: durum, yeniden gönderilen başlıklar ve gövdenin base64'ü. */
interface StoredResponse {
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Kayıtlı yanıtla yeniden gönderilen başlıklar: içerik tipi ve makbuz. */
const KEPT_HEADERS = ['content-type', 'payment-response'] as const;
const PAYMENT_HEADERS = ['payment-signature', 'x-payment'] as const;

/** Route'un 402 yanıtına eklenen uzantı bildirimi (kimlik isteğe bağlı). */
export const paymentIdentifierDeclaration = () => ({ [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension() });

const idempotencyScope = (network: string) => `x402-response:${network}`;

function paymentOf(req: Request): PaymentPayload | null {
  const header = PAYMENT_HEADERS.map((name) => req.header(name)).find((value) => value !== undefined);
  if (header === undefined) return null;
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    // Bozuk başlığı resmi ara katman 402 ile reddeder.
    return null;
  }
}

function storedOf(body: unknown): StoredResponse | null {
  if (typeof body !== 'object' || body === null) return null;
  const { headers, body: content } = body as Partial<StoredResponse>;
  return typeof content === 'string' && typeof headers === 'object' && headers !== null
    ? { headers, body: content }
    : null;
}

/**
 * Yanıtın gövdesini toplar (resmi ara katmanın tampondan boşalttığı yazmalar dahil). `end`'de önce `beforeEnd`
 * beklenir, sonra yanıt kapanır: istemci yanıtı aldığında kayıt tamamlanmış ya da bırakılmıştır.
 */
function interceptEnd(res: Response, beforeEnd: (body: Buffer) => Promise<void>): void {
  const chunks: Buffer[] = [];
  const collect = (chunk: unknown, encoding: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'),
    );
  };
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => Response;
  res.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
    collect(chunk, encoding);
    return write(chunk, encoding, callback);
  }) as Response['write'];
  res.end = ((chunk?: unknown, encoding?: unknown, callback?: unknown) => {
    collect(chunk, encoding);
    res.write = write as Response['write'];
    res.end = end as Response['end'];
    void beforeEnd(Buffer.concat(chunks)).finally(() => end(chunk, encoding, callback));
    return res;
  }) as Response['end'];
}

function sendStored(res: Response, status: number, stored: StoredResponse): void {
  for (const [name, value] of Object.entries(stored.headers)) res.setHeader(name, value);
  res.status(status).end(Buffer.from(stored.body, 'base64'));
}

/** Uzlaştırılmış başarılı yanıtı saklar; diğerlerinde kimliği bırakır. */
async function settle(
  store: PaymentResponseStore,
  scope: string,
  key: string,
  res: Response,
  body: Buffer | null,
): Promise<void> {
  const settled = res.getHeader('payment-response') !== undefined;
  if (body === null || res.statusCode >= 400 || !settled) {
    await store.abandon(scope, key);
    return;
  }
  const headers = Object.fromEntries(
    KEPT_HEADERS.flatMap((name) => {
      const value = res.getHeader(name);
      return value === undefined ? [] : [[name, String(value)]];
    }),
  );
  await store.complete(scope, key, res.statusCode, { headers, body: body.toString('base64') } satisfies StoredResponse);
}

export interface IdempotentEvents {
  onReplay(event: { readonly key: string; readonly network: string }): void;
  onStoreError(error: unknown): void;
}

/** `inner` (resmi ara katman + tekrar koruması) önüne ödeme kimliğiyle idempotent yanıt katmanı koyar. */
export function withIdempotency(
  inner: RequestHandler,
  options: IdempotencyOptions & { readonly clock: () => number; readonly events: IdempotentEvents },
): RequestHandler {
  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1) throw new Error('ttlSeconds pozitif olmalı');
  const { store, events } = options;
  return (req, res, next) => {
    const payload = paymentOf(req);
    if (payload === null) return inner(req, res, next);
    const { id, validation } = extractAndValidatePaymentIdentifier(payload);
    if (!validation.valid) {
      res.status(400).json({ error: 'invalid_payment_identifier', details: validation.errors ?? [] });
      return;
    }
    if (id === null) return inner(req, res, next);
    const scope = idempotencyScope(payload.accepted.network);
    const request = createHash('sha256')
      .update(JSON.stringify([req.method, req.originalUrl, paymentFingerprint(payload)]))
      .digest('hex');
    const now = options.clock();
    store
      .begin(scope, id, request, new Date(now + options.ttlSeconds * 1000), new Date(now))
      .then((begun) => {
        switch (begun.state) {
          case 'completed': {
            const stored = storedOf(begun.body);
            if (stored === null) throw new Error('kayıtlı yanıt okunamadı');
            events.onReplay({ key: id, network: payload.accepted.network });
            sendStored(res, begun.status, stored);
            return;
          }
          case 'in_progress':
            res.status(409).json({ error: 'payment_in_progress' });
            return;
          case 'mismatch':
            res.status(409).json({ error: 'payment_identifier_conflict' });
            return;
          case 'started': {
            let done = false;
            const finish = async (body: Buffer | null) => {
              if (done) return;
              done = true;
              await settle(store, scope, id, res, body).catch(events.onStoreError);
            };
            interceptEnd(res, finish);
            // Yanıt bitmeden kapanan bağlantı (istemci koptu): kimlik bırakılır.
            res.on('close', () => void finish(null));
            inner(req, res, next);
          }
        }
      })
      .catch((error: unknown) => {
        events.onStoreError(error);
        if (!res.headersSent) res.status(503).json({ error: 'idempotency_unavailable' });
      });
  };
}
