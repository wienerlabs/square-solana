// HTTP yüzeyi: `GET /health`, `GET /ready` ve (yapılandırılmışsa) Helius webhook'u `POST /webhooks/helius`.
// Okuma uçları bu serviste değil, API'dedir (BE-18); API `@squaresdk/solana-indexer/read` ile okur. Metrikler
// ayrı uygulamada (`createMetricsApp`), iç ağdaki portta.
import {
  httpMetricsMiddleware,
  metricsResponse,
  sendHealth,
  type HealthProbe,
  type Logger,
  type Registry,
} from '@squaresdk/solana-observability';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { IndexerMetrics } from './metrics.js';
import { heliusWebhookHandler, type WebhookQueue } from './webhook.js';

export interface AppDeps {
  readonly health: HealthProbe;
  readonly metrics: IndexerMetrics;
  readonly log: Logger;
  /** Webhook kapalıysa null. */
  readonly webhook: { readonly authSha256: string; readonly maxBodyBytes: number; readonly queue: WebhookQueue } | null;
}

/** `route` etiketi: eşleşen yol şablonu; eşleşmeyen istekler tek etikette (kardinalite). */
const routeLabel = (req: Request) => (req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched');

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(httpMetricsMiddleware(deps.metrics, routeLabel));

  app.get('/health', (_req, res) => sendHealth(res, deps.health.live()));
  app.get('/ready', async (_req, res) => sendHealth(res, await deps.health.ready()));

  if (deps.webhook) {
    app.post(
      '/webhooks/helius',
      express.json({ limit: deps.webhook.maxBodyBytes }),
      heliusWebhookHandler({ authSha256: deps.webhook.authSha256, queue: deps.webhook.queue, log: deps.log }),
    );
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // express.json hataları (bozuk JSON, büyük gövde) ve beklenmeyenler.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'invalid_body' });
      return;
    }
    deps.log.error('http_error', { error });
    res.status(500).json({ error: 'internal_error' });
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
