// HTTP yüzeyi: `POST /v1/screenings` (tara ve zincire yaz), `GET /v1/screenings/:wallet` (son onaylanmış
// karar), `GET /v1/screenings/:wallet/history` (denetim geçmişi), `GET /health`, `GET /ready`,
// `GET /openapi.json`. Servis iç ağdadır (API ve operatör araçları çağırır); her `/v1` isteği `x-api-key`
// ister. Hız sınırı paylaşılan Postgres sayacıyla (`@squaresdk/solana-hardening`), anahtar başına; tarama
// (her biri bir tx) ve okuma ayrı kurallarla. Metrikler ayrı uygulamada (`createMetricsApp`).
import { randomUUID } from 'node:crypto';
import { rateLimitMiddleware, type RateLimiter } from '@squaresdk/solana-hardening';
import {
  httpMetricsMiddleware,
  metricsResponse,
  sendHealth,
  type HealthProbe,
  type Logger,
  type Registry,
  type ServiceMetrics,
} from '@squaresdk/solana-observability';
import type { ProgramErrorRef } from '@squaresdk/solana-types';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import type { z } from 'zod';
import type { ApiKeyCheck } from './auth.js';
import { openapiDocument } from './openapi.js';
import { HistoryQuerySchema, ScreenRequestSchema, decisionView, type ScreenerErrorCode } from './schemas.js';
import { ScreeningFailedError, type Screener } from './screener.js';
import type { DecisionStore } from './store.js';

export interface AppDeps {
  readonly info: { readonly name: string; readonly version: string };
  readonly screener: Screener;
  readonly store: DecisionStore;
  readonly checkApiKey: ApiKeyCheck;
  readonly limiters: { readonly screen: RateLimiter; readonly read: RateLimiter };
  readonly health: HealthProbe;
  readonly metrics: ServiceMetrics;
  readonly log: Logger;
  readonly jsonMaxBytes: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ScreenerErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
    readonly programError: ProgramErrorRef | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const requestIdOf = (res: Response): string => res.locals['requestId'] as string;
const callerOf = (res: Response): string => res.locals['caller'] as string;

const meta = (res: Response, page: { page: number; limit: number; total: number } | null = null) => ({
  requestId: requestIdOf(res),
  page: page?.page ?? null,
  limit: page?.limit ?? null,
  total: page?.total ?? null,
});

function sendError(res: Response, error: HttpError): void {
  res.status(error.status).json({
    success: false,
    data: null,
    error: { code: error.code, message: error.message, programError: error.programError, details: error.details },
    meta: meta(res),
  });
}

function parse<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError(400, 'invalid_input', `${what} geçersiz`, {
    issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

/** Async rota: atılan hata hata ara katmanına gider. */
const route =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

/** Prisma sürücü adaptörünün bağlantı hatası türleri (`meta.driverAdapterError.cause.kind`). */
const DATABASE_UNAVAILABLE = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TlsConnectionError',
]);

/** Veritabanına ulaşılamadığını gösteren Prisma hataları. */
function isDatabaseUnavailable(error: unknown): boolean {
  const { name, code, meta } = error as {
    name?: unknown;
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
  };
  const kind = meta?.driverAdapterError?.cause?.kind;
  return (
    name === 'PrismaClientInitializationError' ||
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1017' ||
    (typeof kind === 'string' && DATABASE_UNAVAILABLE.has(kind))
  );
}

/** `route` etiketi: eşleşen yol şablonu; eşleşmeyen istekler tek etikette (kardinalite). */
const routeLabel = (req: Request) => (req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched');

export function createApp(deps: AppDeps): express.Express {
  const { log, store } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => {
    const id = randomUUID();
    res.locals['requestId'] = id;
    res.set('X-Request-Id', id);
    next();
  });
  app.use(httpMetricsMiddleware(deps.metrics, routeLabel));

  app.get('/health', (_req, res) => sendHealth(res, deps.health.live()));
  app.get('/ready', async (_req, res) => sendHealth(res, await deps.health.ready()));
  const document = openapiDocument(deps.info);
  app.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  // Anahtar, gövde ayrıştırılmadan önce denetlenir.
  const authorize: RequestHandler = (req, res, next) => {
    const caller = deps.checkApiKey(req.get('x-api-key'));
    if (caller === null) return sendError(res, new HttpError(401, 'unauthorized', 'geçerli bir x-api-key gerekli'));
    res.locals['caller'] = caller;
    next();
  };
  const limit = (kind: 'screen' | 'read') =>
    rateLimitMiddleware<Request, Response>({
      limiter: deps.limiters[kind],
      keyOf: (req) => `screener:${kind}:${callerOf(req.res!)}`,
      reject: (_req, res) => sendError(res, new HttpError(429, 'rate_limited', 'hız sınırı aşıldı')),
    });
  const wallet = (req: Request) => parse(ScreenRequestSchema.shape.wallet, req.params['wallet'], 'wallet');

  app.post(
    '/v1/screenings',
    authorize,
    limit('screen'),
    express.json({ limit: deps.jsonMaxBytes }),
    route(async (req, res) => {
      const body = parse(ScreenRequestSchema, req.body, 'istek gövdesi');
      try {
        const row = await deps.screener.screen(body.wallet, { trigger: 'request', caller: callerOf(res) });
        res.status(200).json({ success: true, data: decisionView(row), error: null, meta: meta(res) });
      } catch (error) {
        if (!(error instanceof ScreeningFailedError)) throw error;
        const details = { decisionId: error.decision.id, reason: error.decision.error };
        throw error.kind === 'source'
          ? new HttpError(503, 'source_unavailable', 'tarama kaynağı yanıt vermedi; karar verilmedi', details)
          : new HttpError(502, 'tx_failed', 'karar zincire yazılamadı', details, error.programError);
      }
    }),
  );

  app.get(
    '/v1/screenings/:wallet',
    authorize,
    limit('read'),
    route(async (req, res) => {
      const row = await store.latestRecorded(wallet(req));
      if (!row) throw new HttpError(404, 'not_found', 'cüzdan için onaylanmış karar yok');
      res.json({ success: true, data: decisionView(row), error: null, meta: meta(res) });
    }),
  );

  app.get(
    '/v1/screenings/:wallet/history',
    authorize,
    limit('read'),
    route(async (req, res) => {
      const address = wallet(req);
      const page = parse(HistoryQuerySchema, req.query, 'sorgu');
      const { items, total } = await store.history(address, page);
      res.json({ success: true, data: items.map(decisionView), error: null, meta: meta(res, { ...page, total }) });
    }),
  );

  app.use((_req, res) => sendError(res, new HttpError(404, 'not_found', 'yol bulunamadı')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) return sendError(res, error);
    // express.json: bozuk JSON (400), büyük gövde (413).
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendError(res, new HttpError(status, 'invalid_input', 'istek gövdesi okunamadı'));
    }
    if (isDatabaseUnavailable(error)) {
      log.error('database_unavailable', { requestId: requestIdOf(res), error });
      return sendError(res, new HttpError(503, 'db_unavailable', 'veritabanı kullanılamıyor'));
    }
    log.error('http_error', { requestId: requestIdOf(res), error });
    return sendError(res, new HttpError(500, 'internal_error', 'beklenmeyen hata'));
  });
  return app;
}

/** Yalnızca iç ağdan erişilen metrik uygulaması. */
export function createMetricsApp(registry: Registry, log: Logger): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    try {
      const { contentType, body } = await metricsResponse(registry);
      res.set('content-type', contentType).send(body);
    } catch (error) {
      log.error('metrics_failed', { error });
      res.status(500).end();
    }
  });
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}
