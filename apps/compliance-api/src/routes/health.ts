import { Router } from 'express';
import { healthCheck } from '../utils/database.js';
import { packageInfo } from '../utils/package-info.js';
import type { ApiResponse } from '../types/api.js';

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'degraded';
  service: string;
  version: string;
  database: boolean;
  uptime: number;
  timestamp: string;
}

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded
 */
router.get('/', async (_req, res) => {
  const dbHealthy = await healthCheck();

  const status: HealthStatus = {
    status: dbHealthy ? 'healthy' : 'degraded',
    service: packageInfo.name,
    version: packageInfo.version,
    database: dbHealthy,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  const response: ApiResponse<HealthStatus> = {
    success: dbHealthy,
    data: status,
    error: dbHealthy ? null : 'Database connection failed',
  };

  res.status(dbHealthy ? 200 : 503).json(response);
});

export default router;
