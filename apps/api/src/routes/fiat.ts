// fiat etiketi: Stripe MPP fiat rayı (BE-25, ADR 0026). Kurumun oturumu ya da `fiat:pay` kapsamlı anahtarı ödemeyi
// açar, kartı kaydeder ve attestation'ı okur. İki uç genel kimlik ara katmanından ve `express.json`'dan önce
// bağlanır (`fiatPreAuthRoutes`):
// - Stripe webhook'u: imza ham gövde üzerindedir; kimliği Stripe'ın imzasıdır.
// - MPP: `Authorization` MPP credential'ını taşır; kimlik yalnızca `X-API-Key`'dir.
// Fiat rayı yapılandırılmamışsa uçlar 503 `payment_unavailable` döner.
import { FiatPaymentCreateSchema, FiatSetupIntentCreateSchema } from '@squaresdk/solana-types';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireActor } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { MppCharger } from '../fiat/mpp.js';
import type { FiatService } from '../fiat/service.js';
import { HttpError, badRequest, conflict, parse, route, sendError, sendOk, unauthorized } from '../http.js';

export interface FiatDeps {
  readonly service: FiatService;
  /** MPP 402 yolu; Stripe profili yapılandırılmamışsa null (uç 503). */
  readonly mpp: MppCharger | null;
  /** API'nin dışarıdan görünen adresi: MPP isteğinin URL'si bununla kurulur. */
  readonly publicBaseUrl: string;
}

const unavailable = () => new HttpError(503, 'payment_unavailable', 'fiat rayı yapılandırılmamış');
const paying = (res: Response) => requireActor(res, 'fiat:pay').wallet;
const param = (req: Request, name: string) => String(req.params[name]);
/** MPP challenge'ından istemciye geçen başlıklar. */
const CHALLENGE_HEADERS = ['www-authenticate', 'cache-control'];

/** Problem ayrıntısı (RFC 9457) varsa mesajı; challenge gövdesi zarfa taşınır. */
async function challengeDetail(challenge: globalThis.Response): Promise<string | null> {
  try {
    const body = (await challenge.clone().json()) as { detail?: unknown; title?: unknown };
    if (typeof body.detail === 'string') return body.detail;
    return typeof body.title === 'string' ? body.title : null;
  } catch {
    return null;
  }
}

/** Kimlik ara katmanından önce bağlanan uçlar: Stripe webhook'u ve MPP. */
export function fiatPreAuthRoutes(deps: {
  fiat: FiatDeps | null;
  auth: AuthService;
  writeLimit: RequestHandler;
  webhookMaxBytes: number;
}): Router {
  const { fiat, auth } = deps;
  const router = Router();

  router.post(
    '/v1/stripe/webhook',
    express.raw({ type: '*/*', limit: deps.webhookMaxBytes }),
    route(async (req, res) => {
      if (!fiat) throw unavailable();
      const signature = req.get('stripe-signature');
      if (!signature) throw badRequest('Stripe-Signature başlığı gerekli');
      if (!Buffer.isBuffer(req.body)) throw badRequest('gövde gerekli');
      sendOk(res, await fiat.service.webhook(req.body, signature));
    }),
  );

  /** Yalnızca `X-API-Key`: `Authorization` credential'ındır. */
  const apiKeyOnly: RequestHandler = (req, res, next) => {
    const apiKey = req.get('x-api-key') ?? null;
    if (apiKey === null) {
      next(unauthorized('MPP ödemesi fiat:pay kapsamlı API anahtarı ister (X-API-Key)'));
      return;
    }
    auth.principal({ bearer: null, apiKey }).then((principal) => {
      res.locals['principal'] = principal;
      next();
    }, next);
  };

  router.post(
    '/v1/jobs/:job/fiat/mpp',
    apiKeyOnly,
    deps.writeLimit,
    route(async (req, res) => {
      if (!fiat) throw unavailable();
      const wallet = paying(res);
      if (!fiat.mpp) throw new HttpError(503, 'payment_unavailable', 'MPP yapılandırılmamış (Stripe profili)');
      const job = await fiat.service.payableJob(param(req, 'job'), wallet);
      const authorization = req.get('authorization');
      const request = new Request(new URL(req.originalUrl, `${fiat.publicBaseUrl}/`), {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      });
      const outcome = await fiat.mpp.charge(request, job);
      if (!outcome.paid) {
        for (const name of CHALLENGE_HEADERS) {
          const value = outcome.challenge.headers.get(name);
          if (value !== null) res.set(name, value);
        }
        const detail = await challengeDetail(outcome.challenge);
        sendError(res, new HttpError(402, 'payment_required', 'ödeme gerekli (MPP)', detail ? { detail } : null));
        return;
      }
      const attestation = await fiat.service.recordMpp(job, outcome.paymentIntent);
      if (!attestation) throw conflict('ödeme işe bağlanamadı; kopya ödeme iade edildi');
      const receipted = outcome.withReceipt(new globalThis.Response(null));
      const receipt = receipted.headers.get('payment-receipt');
      if (receipt !== null) res.set('Payment-Receipt', receipt);
      sendOk(res, attestation);
    }),
  );
  return router;
}

export function fiatRoutes(deps: {
  fiat: FiatDeps | null;
  readLimit: RequestHandler;
  writeLimit: RequestHandler;
}): Router {
  const { fiat, readLimit, writeLimit } = deps;
  const router = Router();
  const service = () => {
    if (!fiat) throw unavailable();
    return fiat.service;
  };

  router.get(
    '/v1/fiat/config',
    readLimit,
    route(async (_req, res) => {
      sendOk(res, service().config());
    }),
  );
  router.post(
    '/v1/fiat/setup-intents',
    writeLimit,
    route(async (req, res) => {
      const fiatService = service();
      const wallet = paying(res);
      const body = parse(FiatSetupIntentCreateSchema, req.body, 'istek');
      sendOk(res, await fiatService.setupIntent(body.institution, wallet), 201);
    }),
  );
  router.get(
    '/v1/fiat/customers/:institution',
    readLimit,
    route(async (req, res) => {
      const fiatService = service();
      sendOk(res, await fiatService.customer(param(req, 'institution'), paying(res)));
    }),
  );
  router.post(
    '/v1/jobs/:job/fiat/payment',
    writeLimit,
    route(async (req, res) => {
      const fiatService = service();
      const wallet = paying(res);
      const body = parse(FiatPaymentCreateSchema, req.body, 'istek');
      sendOk(res, await fiatService.createPayment(param(req, 'job'), wallet, body.offSession), 201);
    }),
  );
  router.get(
    '/v1/jobs/:job/fiat/attestation',
    readLimit,
    route(async (req, res) => {
      const fiatService = service();
      sendOk(res, await fiatService.attestation(param(req, 'job'), paying(res)));
    }),
  );
  router.post(
    '/v1/jobs/:job/fiat/attestation',
    writeLimit,
    route(async (req, res) => {
      const fiatService = service();
      sendOk(res, await fiatService.reconcile(param(req, 'job'), paying(res)));
    }),
  );
  return router;
}
