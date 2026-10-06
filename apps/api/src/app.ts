// HTTP yüzeyi: sözleşmedeki 33 operasyon (docs/api/openapi.yaml), `GET /openapi.json`. Metrikler ayrı
// uygulamada (`createMetricsApp`), iç ağdaki portta. Hız sınırı paylaşılan Postgres sayacıyla
// (`@squaresdk/solana-hardening`): okuma ve yazma uçları ayrı kurallarla, kimliği olan istekte cüzdan, olmayanda
// istemci IP'si başına.
import type { PrismaClient } from '@squaresdk/solana-db';
import { rateLimitMiddleware, type RateLimiter } from '@squaresdk/solana-hardening';
import type { ReadApi } from '@squaresdk/solana-indexer/read';
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
import { authenticate, principalOf } from './auth/middleware.js';
import type { AuthService } from './auth/service.js';
import type { CardService } from './cards.js';
import type { DeliveryService } from './deliveries.js';
import { HttpError, requestId, requestIdOf, sendError } from './http.js';
import type { OpenApiDocument } from './openapi.js';
import type { PolicyMetaService } from './policy-meta.js';
import type { ProverProxy } from './prover.js';
import { authRoutes } from './routes/auth.js';
import { readRoutes } from './routes/reads.js';
import { travelRuleRoutes } from './routes/travel-rule.js';
import { writeRoutes } from './routes/writes.js';
import type { TravelRuleService } from './travel-rule/service.js';
import type { TxBuilder } from './tx.js';

export interface AppDeps {
  readonly db: PrismaClient;
  readonly read: ReadApi;
  readonly auth: AuthService;
  readonly deliveries: DeliveryService;
  readonly cards: CardService;
  readonly policyMeta: PolicyMetaService;
  readonly tx: TxBuilder;
  readonly prover: ProverProxy;
  readonly travelRule: TravelRuleService;
  readonly limiters: { readonly read: RateLimiter; readonly write: RateLimiter };
  readonly openapi: OpenApiDocument;
  readonly health: HealthProbe;
  readonly metrics: ServiceMetrics;
  readonly log: Logger;
  /** İç hatalar (`api_errors` alarmının değeri). */
  readonly errors: EventWindow;
  readonly corsOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly jsonMaxBytes: number;
  readonly deliveryMaxBytes: number;
}

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
  app.get('/openapi.json', (_req, res) => {
    res.json(deps.openapi);
  });

  app.use(authenticate(deps.auth));
  const limit = (kind: 'read' | 'write') =>
    rateLimitMiddleware<Request, Response>({
      limiter: deps.limiters[kind],
      keyOf: (req) => {
        const principal = principalOf(req.res!);
        return `${kind}:${principal ? `wallet:${principal.wallet}` : `ip:${req.ip ?? 'unknown'}`}`;
      },
      reject: (_req, res) => sendError(res, new HttpError(429, 'rate_limited', 'hız sınırı aşıldı')),
    });
  const readLimit = limit('read');
  const writeLimit = limit('write');
  app.use(authRoutes({ auth: deps.auth, readLimit, writeLimit }));
  app.use(readRoutes({ db: deps.db, read: deps.read, readLimit }));
  app.use(travelRuleRoutes({ travelRule: deps.travelRule, readLimit, writeLimit }));
  app.use(
    writeRoutes({
      deliveries: deps.deliveries,
      cards: deps.cards,
      policyMeta: deps.policyMeta,
      read: deps.read,
      tx: deps.tx,
      prover: deps.prover,
      deliveryMaxBytes: deps.deliveryMaxBytes,
      writeLimit,
      readLimit,
    }),
  );

  app.use((_req, res) => sendError(res, new HttpError(404, 'not_found', 'yol bulunamadı')));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      // Bağımlılık hataları (RPC, prover, depo) alarm penceresine sayılır.
      if (error.status >= 500) {
        deps.errors.record();
        log.warn('dependency_error', { requestId: requestIdOf(res), code: error.code, cause: error.cause });
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
