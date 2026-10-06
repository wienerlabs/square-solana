import { Router } from 'express';
import { createHealth, sendHealth } from '@squaresdk/solana-observability';
import { config } from '../config.js';
import { healthCheck } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { packageInfo } from '../utils/package-info.js';

/** Liveness and readiness (`Health`, API contract): readiness checks the database. */
export const health = createHealth({
  version: packageInfo.version,
  checks: { database: () => healthCheck() },
  timeoutMs: config.observability.healthCheckTimeoutMs,
  logger,
});

const router = Router();

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Liveness (the process is up; dependencies are not checked)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: The process is up
 */
router.get('/health', (_req, res) => sendHealth(res, health.live()));

/**
 * @swagger
 * /ready:
 *   get:
 *     summary: Readiness (the database answers)
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Ready
 *       503:
 *         description: A dependency check failed; the reason is in the log
 */
router.get('/ready', async (_req, res) => sendHealth(res, await health.ready()));

export default router;
