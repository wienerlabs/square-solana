import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import proofRouter from './routes/proof.js';
import attestationRouter from './routes/attestation.js';
import complianceReportRouter from './routes/compliance-report.js';
import mppReportRouter from './routes/mpp-report.js';
import healthRouter from './routes/health.js';
import compressedAttestationRouter from './routes/compressed-attestation.js';
import stripeWebhookRouter from './routes/stripe-webhook.js';
import mppProtectedServiceRouter from './routes/mpp-protected-service.js';
import mppPublicConfigRouter from './routes/mpp-public-config.js';
import agentStripeRouter from './routes/agent-stripe.js';
import verifiedPaymentRouter from './routes/verified-payment.js';
import { swaggerSpec } from './swagger.js';

const app = express();

const extraOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cors({
  origin: [/^http:\/\/localhost:\d+$/, ...extraOrigins],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'x-402-payment',
    'x-mpp-credential',
    'x-aperture-proof-record',
  ],
  exposedHeaders: ['WWW-Authenticate', 'Payment-Receipt'],
  credentials: true,
}));
// Stripe webhook MUST mount before express.json — Stripe-Signature is HMAC'd
// over the unparsed request body, and the json parser would consume it.
app.use('/api/v1/mpp', stripeWebhookRouter);

app.use(express.json({ limit: '1mb' }));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/api-docs.json', (_req, res) => {
  res.json(swaggerSpec);
});

app.use('/health', healthRouter);
app.use('/api/v1/proofs', proofRouter);
app.use('/api/v1/attestations', attestationRouter);
app.use('/api/v1/compliance', complianceReportRouter);
app.use('/api/v1/compliance', mppReportRouter);
app.use('/api/v1/compliance', mppProtectedServiceRouter);
app.use('/api/v1/compliance', mppPublicConfigRouter);
app.use('/api/v1', agentStripeRouter);
app.use('/api/v1/compliance', verifiedPaymentRouter);
app.use('/api/v1/compliance', compressedAttestationRouter);

app.use(errorHandler);

const server = app.listen(config.port, () => {
  logger.info(`Compliance API running on port ${config.port}`, {
    port: config.port,
    env: config.nodeEnv,
    swagger: `http://localhost:${config.port}/api-docs`,
  });
});

function gracefulShutdown(signal: string): void {
  logger.info(`Received ${signal}, shutting down gracefully`);
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
