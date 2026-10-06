// HTTP yüzeyi: `GET /health`, `GET /ready`. Keeper günlüğünü API sunar (`GET /v1/keeper/actions`, BE-18).
// Metrikler ayrı uygulamada (`createMetricsApp`), iç ağdaki portta.
import {
  metricsResponse,
  sendHealth,
  type HealthProbe,
  type Logger,
  type Registry,
} from '@squaresdk/solana-observability';
import express from 'express';

export function createApp(deps: { health: HealthProbe }): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => sendHealth(res, deps.health.live()));
  app.get('/ready', async (_req, res) => sendHealth(res, await deps.health.ready()));
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
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
