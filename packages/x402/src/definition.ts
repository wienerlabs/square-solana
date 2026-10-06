// Square geliştirici portalındaki ücretli uç nokta tanımından ücretli route (FE-22, ADR 0023). Tanım Square
// API'sinde durur (`X402Endpoint`: fiyat, mint, ağ, alıcı, açıklama, etkin / pasif); ödemeyi geliştiricinin kendi
// sunucusu ister. Facilitator ve tekrar koruması ADR 0018'deki gibi bu sunucunun geçididir (`createX402Gateway`):
// Square ödeme yolunda değildir. Uzlaştırılan her ödeme `onPayment` ile bildirilir; geliştirici bunu Square
// API'sine (`recordX402Payment`) gönderir ve portaldaki kullanım sayacı artar.
//
// Kaynak fonksiyonsa tanım `refreshSeconds` boyunca önbellekte tutulur: portalda yapılan değişiklik (fiyat,
// pasifleştirme, silme) en geç bu süre sonra uygulanır. Tanım okunamazsa son bilinen tanım kullanılır; hiç
// okunamamışsa istek geçirilmez (503). Pasif uç nokta ödeme istemez ve işleyiciyi çalıştırmaz (503); silinen
// tanımın route'u 404 döner.
import type { RequestHandler } from 'express';
import type { X402Gateway, X402SettledPayment } from './gateway.js';
import { isSolanaNetwork, type SolanaNetwork } from './networks.js';

/** Square API'sinin `X402Endpoint` görünümüyle yapısal olarak aynı (test: definition.test.ts). */
export interface X402EndpointDefinition {
  readonly id: string;
  readonly name: string;
  /** Geliştiricinin sunucusundaki route yolu (bilgi amaçlı; route'u geliştirici bağlar). */
  readonly path: string;
  readonly description: string | null;
  /** Çağrı başına fiyat, mint'in taban biriminde. */
  readonly amount: string;
  readonly mint: string;
  /** CAIP-2 Solana ağı. */
  readonly network: string;
  readonly payTo: string;
  readonly enabled: boolean;
}

/** Square API'sinin `X402PaymentReport` gövdesiyle yapısal olarak aynı: `recordX402Payment`'a olduğu gibi gider. */
export interface X402PaymentRecord {
  /** Ödeme yükünün tekrar koruması kimliği (`paymentFingerprint`). */
  readonly fingerprint: string;
  /** Uzlaştırma işleminin imzası (makbuz). */
  readonly transaction: string;
  readonly network: SolanaNetwork;
  readonly asset: string;
  readonly amount: string;
  readonly payer: string;
  readonly payTo: string;
  /** Unix saniyesi. */
  readonly settledAt: number;
}

/** Sabit tanım ya da tanımı okuyan fonksiyon; fonksiyonun `null` dönmesi tanımın silindiğidir. */
export type X402DefinitionSource = X402EndpointDefinition | (() => Promise<X402EndpointDefinition | null>);

export interface DefinitionRouteOptions {
  /** Kaynak fonksiyonsa tanımın önbellekte kaldığı süre (saniye, varsayılan 30). */
  readonly refreshSeconds?: number;
  /** `paidRoute`'un uzlaştırma anı (varsayılan `after-handler`). */
  readonly settle?: 'after-handler' | 'before-handler';
  readonly maxTimeoutSeconds?: number;
  /** Mutlak kaynak adresi; verilmezse istek adresi. */
  readonly resource?: string;
  readonly mimeType?: string;
  /** Uzlaştırılan her ödeme. Dönen söz yanıtı bekletmez; reddi `onError`'a gider. */
  readonly onPayment?: (payment: X402PaymentRecord, definition: X402EndpointDefinition) => void | Promise<void>;
  /** Tanım okunamadığında ya da `onPayment` başarısız olduğunda. */
  readonly onError?: (error: unknown) => void;
  readonly clock?: () => number;
}

/** Tanımın önbellek süresi. */
export const DEFAULT_DEFINITION_REFRESH_SECONDS = 30;

const refuse = (res: Parameters<RequestHandler>[1], status: number, error: string, message: string) => {
  res.status(status).json({ error, message });
};

/** Kaynağın son okuması: tanım, silinmiş tanım ya da henüz okunamadı. */
type Loaded = { state: 'found'; definition: X402EndpointDefinition } | { state: 'deleted' } | { state: 'unavailable' };

/** Uzlaştırılan ödemeyi Square API'sinin bildirim gövdesine çevirir. */
function paymentRecord(payment: X402SettledPayment, network: SolanaNetwork, settledAtMs: number): X402PaymentRecord {
  return {
    fingerprint: payment.fingerprint,
    transaction: payment.settlement.transaction,
    network,
    asset: payment.asset,
    amount: payment.amount,
    payer: payment.payer,
    payTo: payment.payTo,
    settledAt: Math.floor(settledAtMs / 1000),
  };
}

/**
 * Tanımdan ücretli route ara katmanı. Ödemesiz istek 402 alır; ödeme doğrulanırsa işleyici çalışır ve yanıt
 * başarılıysa ödeme uzlaştırılıp `onPayment` ile bildirilir.
 *
 * ```ts
 * app.get(definition.path, paidRouteFromDefinition(gateway, () => loadDefinition(), { onPayment }), handler);
 * ```
 */
export function paidRouteFromDefinition(
  gateway: X402Gateway,
  source: X402DefinitionSource,
  options: DefinitionRouteOptions = {},
): RequestHandler {
  const clock = options.clock ?? Date.now;
  const refreshMs = (options.refreshSeconds ?? DEFAULT_DEFINITION_REFRESH_SECONDS) * 1000;
  const onError = options.onError ?? (() => undefined);
  let cached: { loaded: Loaded; at: number } | null = null;
  let loading: Promise<Loaded> | null = null;
  // Fiyat, ağ, mint, alıcı ya da açıklama değişince ara katman yeniden kurulur.
  let route: { key: string; handler: RequestHandler } | null = null;

  const load = (read: () => Promise<X402EndpointDefinition | null>): Promise<Loaded> =>
    read().then(
      (definition): Loaded => (definition ? { state: 'found', definition } : { state: 'deleted' }),
      (error: unknown): Loaded => {
        onError(error);
        // Son bilinen tanımla devam edilir; yeniden okuma süre dolunca denenir.
        return cached?.loaded ?? { state: 'unavailable' };
      },
    );

  const current = async (): Promise<Loaded> => {
    if (typeof source !== 'function') return { state: 'found', definition: source };
    if (cached && clock() - cached.at < refreshMs) return cached.loaded;
    loading ??= load(source).then((loaded) => {
      if (loaded.state !== 'unavailable') cached = { loaded, at: clock() };
      return loaded;
    });
    try {
      return await loading;
    } finally {
      loading = null;
    }
  };

  const handlerFor = (definition: X402EndpointDefinition): RequestHandler => {
    const key = JSON.stringify([
      definition.id,
      definition.amount,
      definition.mint,
      definition.network,
      definition.payTo,
      definition.description,
    ]);
    if (route?.key === key) return route.handler;
    const network = definition.network;
    if (!isSolanaNetwork(network)) throw new Error(`tanımın ağı desteklenmiyor: ${network}`);
    const report = options.onPayment;
    const handler = gateway.paidRoute({
      price: { amount: definition.amount, asset: definition.mint },
      payTo: definition.payTo,
      network,
      ...(definition.description === null ? {} : { description: definition.description }),
      ...(options.settle === undefined ? {} : { settle: options.settle }),
      ...(options.maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: options.maxTimeoutSeconds }),
      ...(options.resource === undefined ? {} : { resource: options.resource }),
      ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
      ...(report
        ? {
            onSettled: (payment: X402SettledPayment) => {
              Promise.resolve()
                .then(() => report(paymentRecord(payment, network, clock()), definition))
                .catch(onError);
            },
          }
        : {}),
    });
    route = { key, handler };
    return handler;
  };

  return (req, res, next) => {
    current()
      .then((loaded) => {
        if (loaded.state === 'unavailable') {
          refuse(res, 503, 'x402_definition_unavailable', 'ücretli uç noktanın tanımı okunamadı');
        } else if (loaded.state === 'deleted') {
          refuse(res, 404, 'x402_endpoint_not_found', 'ücretli uç nokta tanımı yok');
        } else if (!loaded.definition.enabled) {
          refuse(res, 503, 'x402_endpoint_disabled', 'ücretli uç nokta pasif');
        } else {
          handlerFor(loaded.definition)(req, res, next);
        }
      })
      .catch(next);
  };
}
