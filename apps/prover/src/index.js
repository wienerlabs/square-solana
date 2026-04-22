import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { generateProof } from './prover.js';
import { openapiSpec } from './openapi.js';

const app = express();
const port = Number(process.env.PROVER_SERVICE_PORT ?? 3003);

const extraOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(helmet());
app.use(
  cors({
    origin: [/^http:\/\/localhost:\d+$/, ...extraOrigins],
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
    service: 'aperture-prover-service',
    version: '0.1.0',
    backend: 'circom+snarkjs',
  });
});

app.post('/prove', async (req, res) => {
  const start = Date.now();
  try {
    const result = await generateProof(req.body);
    const elapsedMs = Date.now() - start;

    console.log(
      JSON.stringify({
        event: 'proof_generated',
        elapsedMs,
        is_compliant: result.is_compliant,
        journal_digest: result.journal_digest,
      }),
    );

    res.json({
      ...result,
      proving_time_ms: elapsedMs,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'proof_failed',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown prover error',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[Aperture Prover Service] Running on port ${port}`);
});
