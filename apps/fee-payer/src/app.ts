// HTTP yüzeyi: `POST /v1/sponsor`, `GET /v1/sponsor/usage`, `GET /v1/sponsor/info`, `/health`, `/ready`.
// Metrikler ayrı uygulamada (`createMetricsApp`), iç ağdaki portta. Bütün `/v1` uçları kimlik ister (API'nin
// oturumu ya da `tx:prepare` kapsamlı anahtarı); hız sınırı cüzdan başına, paylaşılan Postgres sayacıyla
// (`@squaresdk/solana-hardening`).
import { rateLimitMiddleware, type RateLimiter } from '@squaresdk/solana-hardening';
import {
  httpMetricsMiddleware,
  metricsResponse,
  sendHealth,
  type EventWindow,
  type HealthProbe,
  type Logger,
  type Registry,
  type ServiceMetrics,
} from '@squaresdk/solana-observability';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { authenticate, principalOf, type Authenticator } from './auth.js';
import { HttpError, parse, requestId, requestIdOf, route, sendError, sendOk } from './http.js';
import type { SponsorService } from './sponsor.js';

export interface AppDeps {
  readonly auth: Authenticator;
  readonly sponsor: SponsorService;
  readonly limiter: RateLimiter;
  /** `GET /v1/sponsor/info`: sponsor adresi, izinli talimatlar ve tavanlar (istemcinin tx'i kurması için). */
  readonly info: Readonly<Record<string, unknown>>;
  readonly health: HealthProbe;
  readonly metrics: ServiceMetrics;
  readonly log: Logger;
  /** İç hatalar (`fee_payer_errors` alarmının değeri). */
  readonly errors: EventWindow;
  readonly corsOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly jsonMaxBytes: number;
}

const SponsorRequestSchema = z.object({
  transaction: z.string().min(1),
  submit: z.boolean().default(false),
});

/** `route` etiketi: eşleşen yol şablonu; eşleşmeyen istekler tek etikette (kardinalite). */
const routeLabel = (req: Request) => (req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched');

/** Prisma sürücü adaptörünün bağlantı hatası türleri (`meta.driverAdapterError.cause.kind`). */
const DATABASE_UNAVAILABLE = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TlsConnectionError',
]);

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

export function createApp(deps: AppDeps): express.Express {
  const { log } = deps;
  const app = express();
  app.set('trust proxy', deps.trustProxyHops);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: [...deps.corsOrigins],
      allowedHeaders: ['authorization', 'content-type', 'x-api-key'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After'],
    }),
  );
  app.use(requestId);
  app.use(httpMetricsMiddleware(deps.metrics, routeLabel));
  app.use(express.json({ limit: deps.jsonMaxBytes }));

  app.get('/health', (_req, res) => sendHealth(res, deps.health.live()));
  app.get('/ready', async (_req, res) => sendHealth(res, await deps.health.ready()));

  const v1 = express.Router();
  v1.use(authenticate(deps.auth));
  v1.use(
    rateLimitMiddleware<Request, Response>({
      limiter: deps.limiter,
      keyOf: (req) => `fee-payer:wallet:${principalOf(req.res!).wallet}`,
      reject: (_req, res) =>
        sendError(res, new HttpError(429, 'rate_limited', 'hız sınırı aşıldı', { reason: 'rate_limited' })),
    }),
  );
  v1.get('/sponsor/info', (_req, res) => sendOk(res, deps.info));
  v1.get(
    '/sponsor/usage',
    route(async (_req, res) => {
      const usage = await deps.sponsor.usage(principalOf(res).wallet);
      sendOk(res, {
        day: usage.day,
        spentLamports: usage.spentLamports.toString(),
        limitLamports: usage.limitLamports.toString(),
        transactions: usage.transactions,
      });
    }),
  );
  v1.post(
    '/sponsor',
    route(async (req, res) => {
      const body = parse(SponsorRequestSchema, req.body, 'sponsor isteği');
      const principal = principalOf(res);
      const result = await deps.sponsor.sponsor(principal, body);
      log.info('sponsored', {
        requestId: requestIdOf(res),
        wallet: principal.wallet,
        signature: result.signature,
        submitted: result.submitted,
        feeLamports: result.feeLamports,
        rentLamports: result.rentLamports,
      });
      sendOk(res, result);
    }),
  );
  app.use('/v1', v1);

  app.use((_req, res) => sendError(res, new HttpError(404, 'not_found', 'yol bulunamadı')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      if (error.status >= 500) {
        deps.errors.record();
        log.warn('dependency_error', { requestId: requestIdOf(res), code: error.code, cause: error.cause });
      } else if (error.details?.['reason'] !== undefined) {
        log.info('sponsor_rejected', { requestId: requestIdOf(res), reason: error.details['reason'] });
      }
      return sendError(res, error);
    }
    // express.json: bozuk JSON (400), büyük gövde (413).
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendError(res, new HttpError(status, 'invalid_input', 'istek gövdesi okunamadı'));
    }
    deps.errors.record();
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
