import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { logError, logEvent } from './log.js';
import { openapiSpec } from './openapi.js';
import { packageInfo } from './package-info.js';
import { generateProof } from './prover.js';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: [...config.corsOrigins],
    methods: ['GET', 'POST'],
  }),
);
app.use(express.json({ limit: '256kb' }));

app.get('/api-docs.json', (_req, res) => {
  res.json(openapiSpec);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: packageInfo.name,
    version: packageInfo.version,
    backend: 'circom+snarkjs',
  });
});

app.post('/prove', async (req, res) => {
  const start = Date.now();
  try {
    const result = await generateProof(req.body);
    const elapsedMs = Date.now() - start;

    logEvent('proof_generated', {
      elapsedMs,
      is_compliant: result.is_compliant,
      journal_digest: result.journal_digest,
    });
    if (!result.is_compliant) {
      // The request carries the private policy; only public outputs are logged.
      logEvent('compliance_violation', { public_signals: result.public_signals });
    }

    res.json({
      ...result,
      proving_time_ms: elapsedMs,
    });
  } catch (error) {
    logError('proof_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown prover error',
    });
  }
});

app.listen(config.port, '0.0.0.0', () => {
  logEvent('listening', { service: packageInfo.name, port: config.port });
});
