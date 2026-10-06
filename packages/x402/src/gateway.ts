// x402 v2 geçidi: resmi `x402ResourceServer` + Solana exact şeması + resmi Express ara katmanı
// (`@x402/express`). Bu dosya protokolü yeniden yazmaz; yalnızca şunları ekler:
// - kalıcı tekrar koruması: doğrulanan (ya da işleyiciden önce uzlaştırılan) ödeme yükü `ReplayStore`'a
//   işlenir, aynı yük ikinci kez gelirse istek 402 `payment_replayed` ile reddedilir. Depo hatasında istek
//   geçirilmez;
// - işleyiciye ödeme bilgisi: `getX402Payment(res)` ödeyeni, tutarı ve (işleyiciden önce uzlaştırılmışsa)
//   işlem imzasını verir;
// - isteğe bağlı idempotent yanıt (`idempotency`): ödeme kimliğiyle gelen tekrar kayıtlı yanıtı alır
//   (idempotent.ts);
// - gözlem olayları (`onEvent`): doğrulandı, tekrar reddedildi, uzlaştırıldı, uzlaştırma başarısız, kayıtlı
//   yanıt döndü;
// - route başına uzlaştırma geri çağırması (`onSettled`): kullanım sayacı için zincire yazılan ödeme (FE-22).
import { AsyncLocalStorage } from 'node:async_hooks';
import { x402ResourceServer, type FacilitatorClient, type RouteConfig } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, Price } from '@x402/core/types';
import { paymentMiddleware } from '@x402/express';
import { registerExactSvmScheme } from '@x402/svm/exact/server';
import type { RequestHandler, Response } from 'express';
import { paymentIdentifierDeclaration, withIdempotency, type IdempotencyOptions } from './idempotent.js';
import type { SolanaNetwork } from './networks.js';
import { paymentFingerprint, replayScope, type ReplayStore } from './replay.js';

/** Ödeme yükünün tekrar kaydı bu süre tutulur. Solana işleminin blok hash'i ~2 dakikada geçersizleşir. */
export const DEFAULT_REPLAY_TTL_SECONDS = 86_400;

export interface X402Payment {
  /** Ödeme yükünün kimliği (`paymentFingerprint`); tekrar koruması bu değerle tutulur. */
  readonly fingerprint: string;
  readonly payer: string;
  /** CAIP-2. */
  readonly network: string;
  /** Token mint'i. */
  readonly asset: string;
  /** Mint'in taban biriminde tutar. */
  readonly amount: string;
  readonly payTo: string;
  /** Yalnızca `settle: 'before-handler'` route'larında: işleyici çalışmadan önce zincire yazılan işlem. */
  readonly settlement?: { readonly transaction: string; readonly network: string };
}

export type X402Event =
  | { readonly type: 'verified'; readonly payment: X402Payment }
  | { readonly type: 'replay_rejected'; readonly fingerprint: string; readonly network: string }
  | { readonly type: 'replay_guard_error'; readonly fingerprint: string; readonly error: unknown }
  | {
      readonly type: 'settled';
      readonly fingerprint: string;
      readonly network: string;
      readonly transaction: string;
      readonly payer: string;
    }
  | { readonly type: 'settle_failed'; readonly fingerprint: string; readonly network: string; readonly reason: string }
  | { readonly type: 'settled_callback_error'; readonly fingerprint: string; readonly error: unknown }
  | { readonly type: 'idempotent_replay'; readonly key: string; readonly network: string }
  | { readonly type: 'idempotency_error'; readonly error: unknown };

export interface X402GatewayOptions {
  /** `createFacilitatorClient(...)` çıktısı (ADR 0018: varsayılan kendi facilitator'ımız). */
  readonly facilitator: FacilitatorClient;
  /** Kalıcı tekrar koruması; servislerde `createPrismaReplayStore(client)` (`replay_guards`). */
  readonly replay: ReplayStore;
  /** Kabul edilen ağlar; verilmezse tüm Solana ağları (`solana:*`). */
  readonly networks?: readonly SolanaNetwork[];
  /** Verilirse 402 yanıtı güncel blok hash'ini taşır; ödeyen istemci RPC'ye gitmeden işlemi kurar. */
  readonly rpcUrl?: string;
  readonly replayTtlSeconds?: number;
  /**
   * Verilirse route'lar resmi `payment-identifier` uzantısını duyurur; aynı kimlikle gelen tekrar kayıtlı
   * yanıtı ikinci kez ücret alınmadan alır (idempotent.ts).
   */
  readonly idempotency?: IdempotencyOptions;
  readonly clock?: () => number;
  readonly onEvent?: (event: X402Event) => void;
}

export interface PaidRouteOptions {
  /** `"$0.01"` (ağın USDC'si) ya da `{ amount: '<taban birim>', asset: '<mint>' }`. */
  readonly price: Price;
  /** Ödemeyi alan cüzdan (ATA'sı mint'e göre türetilir). */
  readonly payTo: string;
  readonly network: SolanaNetwork;
  readonly description?: string;
  readonly mimeType?: string;
  /** Ödeme yükünün geçerli kaldığı süre (saniye). */
  readonly maxTimeoutSeconds?: number;
  /** Mutlak kaynak adresi; verilmezse istek adresi kullanılır. */
  readonly resource?: string;
  /**
   * `after-handler` (varsayılan, x402 `authorization` akışı): ödeme doğrulanır, işleyici çalışır, yanıt
   * başarılıysa uzlaştırılır; işleyici hata dönerse ödeme alınmaz.
   * `before-handler` (`upfront` akışı): ödeme işleyiciden önce zincire yazılır; işleyici işlem imzasını
   * `getX402Payment(res).settlement` ile görür.
   */
  readonly settle?: 'after-handler' | 'before-handler';
  /**
   * Bu route'ta uzlaştırılan her ödeme (iki akışta da, zincire yazıldıktan sonra). Kullanım sayacı ve muhasebe
   * içindir; geri çağırmanın attığı hata yanıtı etkilemez, `settled_callback_error` olayı olur.
   */
  readonly onSettled?: (payment: X402SettledPayment) => void;
}

/** Zincire yazılmış ödeme: ödeme bilgisi ve uzlaştırma işlemi. */
export interface X402SettledPayment extends X402Payment {
  readonly settlement: { readonly transaction: string; readonly network: string };
}

export interface X402Gateway {
  readonly resourceServer: x402ResourceServer;
  /** Ücretli route ara katmanı: ödeme yoksa 402 + `PAYMENT-REQUIRED`, ödendiyse yanıtta `PAYMENT-RESPONSE`. */
  paidRoute(options: PaidRouteOptions): RequestHandler;
}

interface RequestState {
  payment?: X402Payment;
  readonly onSettled?: (payment: X402SettledPayment) => void;
}

const LOCALS_KEY = 'squareX402';

/** Ücretli route'un işleyicisinde ödeme bilgisi; route `paidRoute` arkasında değilse `undefined`. */
export function getX402Payment(res: Pick<Response, 'locals'>): X402Payment | undefined {
  return (res.locals[LOCALS_KEY] as RequestState | undefined)?.payment;
}

type Claim = 'ok' | 'replayed' | 'error';

export function createX402Gateway(options: X402GatewayOptions): X402Gateway {
  const clock = options.clock ?? Date.now;
  const ttlMs = (options.replayTtlSeconds ?? DEFAULT_REPLAY_TTL_SECONDS) * 1000;
  const emit = (event: X402Event) => options.onEvent?.(event);
  const storage = new AsyncLocalStorage<RequestState>();

  const server = new x402ResourceServer(options.facilitator);
  registerExactSvmScheme(server, {
    ...(options.networks?.length ? { networks: [...options.networks] } : {}),
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  });

  const claim = async (fingerprint: string, network: string): Promise<Claim> => {
    const now = clock();
    try {
      const fresh = await options.replay.claim(replayScope(network), fingerprint, new Date(now + ttlMs), new Date(now));
      if (fresh) return 'ok';
      emit({ type: 'replay_rejected', fingerprint, network });
      return 'replayed';
    } catch (error) {
      emit({ type: 'replay_guard_error', fingerprint, error });
      return 'error';
    }
  };
  const abort = (result: Claim) =>
    result === 'replayed'
      ? { abort: true as const, reason: 'payment_replayed', message: 'bu ödeme yükü daha önce kullanıldı' }
      : { abort: true as const, reason: 'replay_guard_unavailable', message: 'tekrar koruması şu an denetlenemiyor' };
  const describe = (
    payload: Pick<PaymentPayload, 'accepted' | 'payload'>,
    requirements: Pick<PaymentRequirements, 'network' | 'asset' | 'amount' | 'payTo'>,
    payer: string,
  ): X402Payment => ({
    fingerprint: paymentFingerprint(payload),
    payer,
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
  });

  // `authorization` akışı: facilitator doğruladıktan sonra, işleyiciden önce kayıt. Sahte yük gerçek bir
  // kimliği tüketemez; eşzamanlı iki tekrardan yalnızca biri geçer.
  server.onAfterVerify(async ({ paymentPayload, requirements, result }) => {
    if (!result.isValid) return;
    const payment = describe(paymentPayload, requirements, result.payer ?? '');
    const claimed = await claim(payment.fingerprint, payment.network);
    if (claimed !== 'ok') return abort(claimed);
    const state = storage.getStore();
    if (state) state.payment = payment;
    emit({ type: 'verified', payment });
  });

  // `upfront` akışında doğrulama uzlaştırmanın içindedir: kayıt işleyiciden önceki uzlaştırmadan hemen önce.
  server.onBeforeSettle(async ({ paymentPayload, requirements, phase }) => {
    if (phase !== 'before-handler') return;
    const claimed = await claim(paymentFingerprint(paymentPayload), requirements.network);
    if (claimed !== 'ok') return abort(claimed);
  });

  server.onAfterSettle(async ({ paymentPayload, requirements, result, phase }) => {
    const fingerprint = paymentFingerprint(paymentPayload);
    if (!result.success) {
      emit({
        type: 'settle_failed',
        fingerprint,
        network: requirements.network,
        reason: result.errorReason ?? 'unknown',
      });
      return;
    }
    const payer = result.payer ?? '';
    emit({ type: 'settled', fingerprint, network: requirements.network, transaction: result.transaction, payer });
    const state = storage.getStore();
    if (!state) return;
    const settled: X402SettledPayment = {
      ...describe(paymentPayload, requirements, payer),
      settlement: { transaction: result.transaction, network: result.network },
    };
    if (phase === 'before-handler') state.payment = settled;
    try {
      state.onSettled?.(settled);
    } catch (error) {
      emit({ type: 'settled_callback_error', fingerprint, error });
    }
  });

  server.onSettleFailure(async ({ paymentPayload, requirements, error }) => {
    emit({
      type: 'settle_failed',
      fingerprint: paymentFingerprint(paymentPayload),
      network: requirements.network,
      reason: error.message,
    });
  });

  return {
    resourceServer: server,
    paidRoute(route) {
      const config: RouteConfig = {
        accepts: {
          scheme: 'exact',
          price: route.price,
          payTo: route.payTo,
          network: route.network,
          ...(route.maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds: route.maxTimeoutSeconds }),
          ...(route.settle === 'before-handler' ? { extra: { paymentFlow: 'upfront' } } : {}),
        },
        ...(route.description === undefined ? {} : { description: route.description }),
        ...(route.mimeType === undefined ? {} : { mimeType: route.mimeType }),
        ...(route.resource === undefined ? {} : { resource: route.resource }),
        ...(options.idempotency ? { extensions: paymentIdentifierDeclaration() } : {}),
      };
      const middleware = paymentMiddleware(config, server);
      const handler: RequestHandler = (req, res, next) => {
        const state: RequestState = route.onSettled ? { onSettled: route.onSettled } : {};
        res.locals[LOCALS_KEY] = state;
        storage.run(state, () => {
          middleware(req, res, next).catch(next);
        });
      };
      if (!options.idempotency) return handler;
      return withIdempotency(handler, {
        ...options.idempotency,
        clock,
        events: {
          onReplay: ({ key, network }) => emit({ type: 'idempotent_replay', key, network }),
          onStoreError: (error) => emit({ type: 'idempotency_error', error }),
        },
      });
    },
  };
}
