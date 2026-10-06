// Metrics, alarms and the internal metrics server (`@squaresdk/solana-observability`, BE-12).
import express, { type Request } from 'express';
import {
  alarmNotifiers,
  createAlarms,
  createServiceMetrics,
  metricsResponse,
  type AlarmRule,
} from '@squaresdk/solana-observability';
import { config } from './config.js';
import { healthCheck } from './utils/database.js';
import { errorWindow, logger } from './utils/logger.js';
import { packageInfo } from './utils/package-info.js';

export const metrics = createServiceMetrics({ service: packageInfo.name, version: packageInfo.version });

/** Matched route template; unmatched requests share one label (cardinality). */
export const routeLabel = (req: Request): string =>
  req.route ? `${req.baseUrl}${String(req.route.path)}` : 'unmatched';

const rules: AlarmRule[] = [
  {
    name: 'compliance_errors',
    description: `More error log lines than allowed in the last ${config.alerts.errorWindowSeconds} s`,
    severity: 'critical',
    read: () => errorWindow.count(),
    above: config.alerts.errors,
    forSeconds: 0,
  },
  {
    name: 'compliance_database_down',
    description: 'The database does not answer',
    severity: 'critical',
    read: async () => ((await healthCheck()) ? 0 : 1),
    above: 0,
    forSeconds: config.alerts.databaseDownSeconds,
  },
];

export const alarms = createAlarms({
  service: packageInfo.name,
  rules,
  notifiers: alarmNotifiers(config.observability),
  logger,
  registry: metrics.registry,
});

/** Internal-only app that serves `GET /metrics`. */
export function createMetricsApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/metrics', async (_req, res) => {
    try {
      const { contentType, body } = await metricsResponse(metrics.registry);
      res.set('content-type', contentType).send(body);
    } catch (error) {
      logger.error('metrics_failed', { error });
      res.status(500).end();
    }
  });
  app.use((_req, res) => {
    res.status(404).end();
  });
  return app;
}
