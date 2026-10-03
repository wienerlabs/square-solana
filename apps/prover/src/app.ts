// HTTP yüzeyi: `POST /v1/prove` (API sözleşmesindeki istek, yanıt ve zarf), `GET /health`,
// `GET /ready`, `GET /openapi.json`. Metrikler ayrı uygulamada (`createMetricsApp`).
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import { ProveRequestSchema, type ApiErrorCode, type Health } from '@squaresdk/solana-types';
import type { Registry } from 'prom-client';
import type { ApiKeyCheck } from './auth.js';
import { errorMessage, errorSummary } from './errors.js';
import { CapacityError, type Limiter } from './limiter.js';
import type { Log, LogFields } from './log.js';
import type { ProofResult, ProverMetrics } from './metrics.js';
import { openapiDocument } from './openapi.js';
import { InvalidWitnessError, type Prover } from './prover.js';

/** Release witness'ı birkaç KB'dir (yaklaşık 60 alan elemanı); daha büyük gövde reddedilir. */
const MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  readonly info: { readonly name: string; readonly version: string };
  readonly corsOrigins: readonly string[];
  readonly checkApiKey: ApiKeyCheck;
  readonly prover: Prover;
  readonly limiter: Limiter;
  /** 503 yanıtındaki `Retry-After` (saniye). */
  readonly retryAfterSecs: number;
  readonly metrics: ProverMetrics;
  readonly log: Log;
}

const requestIdOf = (res: Response): string => res.locals['requestId'] as string;
const meta = (requestId: string) => ({ requestId, page: null, limit: null, total: null });

function fail(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  details: Record<string, unknown> | null = null,
): void {
  res.status(status).json({
    success: false,
    data: null,
    error: { code, message, programError: null, details },
    meta: meta(requestIdOf(res)),
  });
}

function health(res: Response, status: number, body: Health): void {
  res.status(status).set('cache-control', 'no-store').json(body);
}

/** `route` etiketi: eşleşen yol şablonu; eşleşmeyen istekler tek etikette toplanır (kardinalite). */
const routeLabel = (req: Request) => (req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched');

export function createApp(deps: AppDeps): express.Express {
  const { prover, limiter, metrics, log } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.locals['requestId'] = requestId;
    res.set('x-request-id', requestId);
    res.on('finish', () => {
      metrics.httpRequests.inc({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
    });
    next();
  });
  app.use(helmet());
  app.use(cors({ origin: [...deps.corsOrigins], methods: ['GET', 'POST'] }));

  const record = (res: Response, result: ProofResult, fields: LogFields = {}) => {
    metrics.proofs.inc({ result });
    log.event('prove', { requestId: requestIdOf(res), result, ...fields });
  };

  // Anahtar, gövde ayrıştırılmadan önce denetlenir.
  const authorize: RequestHandler = (req, res, next) => {
    if (deps.checkApiKey(req.get('x-api-key'))) return next();
    record(res, 'unauthorized');
    fail(res, 401, 'unauthorized', 'geçerli bir x-api-key gerekli');
  };

  app.post('/v1/prove', authorize, express.json({ limit: MAX_BODY_BYTES }), async (req, res) => {
    const parsed = ProveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      record(res, 'invalid_input');
      return fail(res, 400, 'invalid_input', 'istek ProveRequest şemasına uymuyor', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    if (parsed.data.artifactVersion !== prover.version) {
      record(res, 'artifact_mismatch');
      return fail(res, 409, 'conflict', 'artifactVersion yüklü zkey ile uyuşmuyor', {
        expected: prover.version,
        received: parsed.data.artifactVersion,
      });
    }
    try {
      const proof = await limiter.run(() => prover.prove(parsed.data.witness));
      metrics.provingSeconds.observe(proof.provingMs / 1000);
      record(res, 'ok', { provingMs: proof.provingMs, refusalCode: Number(BigInt(`0x${proof.publicInputs[0]!}`)) });
      res.json({ success: true, data: proof, error: null, meta: meta(requestIdOf(res)) });
    } catch (error) {
      if (error instanceof CapacityError) {
        record(res, 'capacity', { reason: error.reason });
        res.set('retry-after', String(deps.retryAfterSecs));
        return fail(res, 503, 'prover_unavailable', error.message);
      }
      if (error instanceof InvalidWitnessError) {
        record(res, 'invalid_witness');
        return fail(res, 400, 'invalid_input', error.message);
      }
      record(res, 'error');
      log.error('prove_failed', {
        requestId: requestIdOf(res),
        error: errorSummary(error),
      });
      return fail(res, 500, 'internal_error', 'ispat üretilemedi');
    }
  });

  app.get('/health', (_req, res) => health(res, 200, { status: 'ok', version: deps.info.version, checks: {} }));

  app.get('/ready', (_req, res) => {
    const capacity = limiter.hasCapacity();
    health(res, capacity ? 200 : 503, {
      status: capacity ? 'ok' : 'degraded',
      version: deps.info.version,
      // Artefaktlar açılışta doğrulandı; doğrulanamasaydı süreç açılmazdı.
      checks: { artifacts: 'ok', capacity: capacity ? 'ok' : 'fail' },
    });
  });

  const document = openapiDocument({ ...deps.info, artifactVersion: prover.version });
  app.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  app.use((_req, res) => fail(res, 404, 'not_found', 'yol bulunamadı'));

  // express.json hataları (bozuk JSON, büyük gövde) ve beklenmeyenler.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      record(res, 'invalid_input');
      return fail(res, status, 'invalid_input', errorMessage(error));
    }
    log.error('http_error', { requestId: requestIdOf(res), error: errorSummary(error) });
    return fail(res, 500, 'internal_error', 'beklenmeyen hata');
  });

  return app;
}

/** Yalnızca iç ağdan erişilen metrik uygulaması. */
export function createMetricsApp(registry: Registry, log: Log): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    try {
      res.set('content-type', registry.contentType).send(await registry.metrics());
    } catch (error) {
      log.error('metrics_failed', { error: errorSummary(error) });
      res.status(500).end();
    }
  });
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}
