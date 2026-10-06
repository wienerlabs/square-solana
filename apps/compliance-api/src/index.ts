import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import proofRouter from './routes/proof.js';
import attestationRouter from './routes/attestation.js';
import { createComplianceReportRouter } from './routes/compliance-report.js';
import mppReportRouter from './routes/mpp-report.js';
import healthRouter from './routes/health.js';
import stripeWebhookRouter from './routes/stripe-webhook.js';
import mppPublicConfigRouter from './routes/mpp-public-config.js';
import agentStripeRouter from './routes/agent-stripe.js';
import verifiedPaymentRouter from './routes/verified-payment.js';
import unattestedPaymentsRouter from './routes/unattested-payments.js';
import { startSolanaWatcher, stopSolanaWatcher } from './watchers/solana-watcher.js';
import { startStripeReconciler, stopStripeReconciler } from './watchers/stripe-watcher.js';
import { swaggerSpec } from './swagger.js';
import { httpMetricsMiddleware } from '@squaresdk/solana-observability';
import { alarms, createMetricsApp, metrics, routeLabel } from './observability.js';
import { purgeExpiredReplayGuards, x402Paywall, x402Ready } from './x402.js';

const app = express();

app.disable('x-powered-by');
app.use(httpMetricsMiddleware(metrics, routeLabel));
app.use(helmet());
app.use(
  cors({
    origin: [...config.corsOrigins],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'PAYMENT-SIGNATURE',
      'x-mpp-credential',
      'x-aperture-proof-record',
    ],
    exposedHeaders: ['WWW-Authenticate', 'Payment-Receipt', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
    credentials: true,
  }),
);
// Stripe webhook MUST mount before express.json — Stripe-Signature is HMAC'd
// over the unparsed request body, and the json parser would consume it.
app.use('/api/v1/mpp', stripeWebhookRouter);

app.use(express.json({ limit: '1mb' }));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerSpec);
});

app.use(healthRouter);
app.use('/api/v1/proofs', proofRouter);
app.use('/api/v1/attestations', attestationRouter);
app.use(
  '/api/v1/compliance',
  createComplianceReportRouter(x402Paywall(config.x402.reportPrice, 'Aperture Compliance Report')),
);
app.use('/api/v1/compliance', mppReportRouter);
app.use('/api/v1/compliance', mppPublicConfigRouter);
app.use('/api/v1', agentStripeRouter);
app.use('/api/v1/compliance', verifiedPaymentRouter);
app.use('/api/v1/unattested-payments', unattestedPaymentsRouter);

app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`Compliance API running on port ${config.port}`, {
    port: config.port,
    metricsPort: config.metricsPort,
    env: config.nodeEnv,
    alertWebhook: config.observability.webhook !== null,
  });
  startSolanaWatcher();
  startStripeReconciler();
});
const metricsServer = createMetricsApp().listen(config.metricsPort);
const stopAlarms = alarms.start(config.observability.alertEvaluationSeconds * 1000);
const stopReplayPurge = purgeExpiredReplayGuards();
x402Ready.catch((error: unknown) => {
  logger.error('x402 setup failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

function gracefulShutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully`);
  stopSolanaWatcher();
  stopStripeReconciler();
  stopAlarms();
  stopReplayPurge();
  metricsServer.close();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
