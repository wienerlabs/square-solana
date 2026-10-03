// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da
// geçersiz değerde servis açılmaz. Varsayılan değer yoktur.
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const port = int(1, 65_535);
const commaList = (item: z.ZodType<string, string>) =>
  nonEmpty
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1));

const EnvSchema = z
  .object({
    PROVER_SERVICE_PORT: port,
    /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
    PROVER_METRICS_PORT: port,
    CORS_ORIGINS: commaList(z.url()),
    /** İzinli API anahtarlarının SHA-256'sı (64 hex, virgülle); anahtarın kendisi ortamda tutulmaz. */
    PROVER_API_KEY_SHA256: commaList(z.string().regex(/^[0-9a-f]{64}$/, '64 küçük harf hex bekleniyor')),
    /** Aynı anda üretilen en fazla ispat. */
    PROVER_MAX_CONCURRENT: int(1),
    /** Sırada bekleyebilecek en fazla istek; dolunca 503. */
    PROVER_MAX_QUEUE: int(0),
    /** Sırada bekleme sınırı (ms); aşılınca 503. */
    PROVER_QUEUE_TIMEOUT_MS: int(1),
    /** `circuits/payment-compliance/artifacts/manifest.json`; wasm ve zkey'in SHA-256'ları buradan. */
    PROVER_MANIFEST_PATH: nonEmpty,
    PROVER_WASM_PATH: nonEmpty,
    PROVER_ZKEY_PATH: nonEmpty,
  })
  .refine((env) => env.PROVER_SERVICE_PORT !== env.PROVER_METRICS_PORT, {
    path: ['PROVER_METRICS_PORT'],
    message: 'PROVER_SERVICE_PORT ile aynı olamaz',
  });

export interface LimiterConfig {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
  readonly queueTimeoutMs: number;
}

export interface ArtifactPaths {
  readonly manifestPath: string;
  readonly wasmPath: string;
  readonly zkeyPath: string;
}

export interface ProverConfig {
  readonly port: number;
  readonly metricsPort: number;
  readonly corsOrigins: readonly string[];
  readonly apiKeySha256: readonly string[];
  readonly limits: LimiterConfig;
  readonly artifacts: ArtifactPaths;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ProverConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Geçersiz prover ortamı:\n${problems}`);
  }
  const e = parsed.data;
  return Object.freeze({
    port: e.PROVER_SERVICE_PORT,
    metricsPort: e.PROVER_METRICS_PORT,
    corsOrigins: Object.freeze([...e.CORS_ORIGINS]),
    apiKeySha256: Object.freeze([...new Set(e.PROVER_API_KEY_SHA256)]),
    limits: Object.freeze({
      maxConcurrent: e.PROVER_MAX_CONCURRENT,
      maxQueue: e.PROVER_MAX_QUEUE,
      queueTimeoutMs: e.PROVER_QUEUE_TIMEOUT_MS,
    }),
    artifacts: Object.freeze({
      manifestPath: e.PROVER_MANIFEST_PATH,
      wasmPath: e.PROVER_WASM_PATH,
      zkeyPath: e.PROVER_ZKEY_PATH,
    }),
  });
}
