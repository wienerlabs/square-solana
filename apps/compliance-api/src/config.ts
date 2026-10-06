import dotenv from 'dotenv';
import path from 'node:path';
import { parseObservabilityEnv } from '@squaresdk/solana-observability';
import { toSolanaNetwork } from '@squaresdk/solana-x402';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/// Every deployment-dependent value comes from the environment and is
/// validated at boot; nothing falls back to a built-in URL, network, address,
/// port or price. Variables marked optional switch a feature on when present
/// (the corresponding route answers 503 while it is off). Log level, readiness timeout and alerting are
/// shared with the other services (`@squaresdk/solana-observability`, BE-12).

const nonEmpty = z.string().trim().min(1);
const intFromEnv = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.pipe(z.coerce.number().int().min(min).max(max));
const base58Pubkey = z
  .string()
  .trim()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'must be a base58 Solana public key');
const optionalSecret = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : null));
const commaList = (item: z.ZodString) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item));

const EnvSchema = z
  .object({
    COMPLIANCE_API_PORT: intFromEnv(1, 65535),
    /// Internal-only port that serves `GET /metrics` (Prometheus).
    COMPLIANCE_METRICS_PORT: intFromEnv(1, 65535),
    NODE_ENV: z.enum(['development', 'test', 'production']),
    CORS_ORIGINS: commaList(z.string().url()).refine((list) => list.length > 0, 'at least one origin'),

    POSTGRES_HOST: nonEmpty,
    POSTGRES_PORT: intFromEnv(1, 65535),
    POSTGRES_USER: nonEmpty,
    POSTGRES_PASSWORD: nonEmpty,
    POSTGRES_DB: nonEmpty,

    STRIPE_SECRET_KEY: nonEmpty,
    STRIPE_API_VERSION: nonEmpty,
    /// Signing secret (whsec_…) for /api/v1/mpp/webhook.
    STRIPE_WEBHOOK_SECRET: optionalSecret,
    /// pk_test_… / pk_live_…, surfaced by /mpp/public-config for Stripe Elements.
    STRIPE_PUBLISHABLE_KEY: optionalSecret,
    /// 64-byte Solana keypair (base58 or JSON array) that signs canonical
    /// Stripe receipts for the verifier's ed25519 check.
    MPP_AUTHORITY_KEYPAIR_BASE58: optionalSecret,
    MPP_SECRET_KEY: nonEmpty,
    MPP_REALM: nonEmpty,
    MPP_REPORT_PRICE_CENTS: intFromEnv(1),
    MPP_REPORT_CURRENCY: z
      .string()
      .trim()
      .regex(/^[a-z]{3}$/, 'must be a lowercase ISO 4217 code'),

    SOLANA_RPC_URL: z.string().url(),
    VERIFIER_PROGRAM: base58Pubkey,

    /// CAIP-2 id or the v1 name (`solana`, `solana-devnet`); normalised to CAIP-2.
    X402_NETWORK: nonEmpty.transform((value, ctx) => {
      try {
        return toSolanaNetwork(value);
      } catch (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
        return z.NEVER;
      }
    }),
    X402_PAYMENT_MINT: base58Pubkey,
    X402_PUBLISHER_WALLET: base58Pubkey,
    /// Report price in the payment mint's base units.
    X402_REPORT_PRICE: intFromEnv(1),
    /// Facilitator (ADR 0018). Unset: our own facilitator; X402_FEE_PAYER_KEYPAIR pays the transaction
    /// fees and SOLANA_RPC_URL verifies and submits. Set: a remote x402 facilitator at this URL.
    X402_FACILITATOR_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    /// Bearer token for X402_FACILITATOR_URL.
    X402_FACILITATOR_TOKEN: optionalSecret,
    /// 64-byte Solana keypair (base58 or JSON array) of the fee payer; holds SOL only, never the payee.
    X402_FEE_PAYER_KEYPAIR: optionalSecret,
    /// Square's single Postgres (db/); x402 payment replay guards live in its `replay_guards` table.
    DATABASE_URL: nonEmpty,
    /// How long a settled report is kept for a retry with the same payment identifier (`idempotency_records`).
    X402_IDEMPOTENCY_TTL_SECONDS: intFromEnv(1),

    /// Enables the unattested-payment watcher.
    HELIUS_API_KEY: optionalSecret,
    /// Enhanced Transactions API base URL for the cluster being watched.
    HELIUS_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    COMPLIANCE_WATCHER_INTERVAL_MS: intFromEnv(5_000),
    /// Mint allow list; unset watches every SPL transfer Helius returns.
    COMPLIANCE_WATCHER_MINTS: commaList(base58Pubkey).optional(),
    COMPLIANCE_STRIPE_RECONCILE_DELAY_MS: intFromEnv(0),

    /// `compliance_errors` alarm: more error log lines than this ...
    COMPLIANCE_ALERT_ERRORS: intFromEnv(0),
    /// ... within this many seconds.
    COMPLIANCE_ALERT_ERROR_WINDOW_SECONDS: intFromEnv(1),
    /// `compliance_database_down` alarm: the database check fails for this many seconds.
    COMPLIANCE_ALERT_DB_DOWN_SECONDS: intFromEnv(0),
  })
  .superRefine((env, ctx) => {
    if (env.COMPLIANCE_METRICS_PORT === env.COMPLIANCE_API_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COMPLIANCE_METRICS_PORT'],
        message: 'must differ from COMPLIANCE_API_PORT',
      });
    }
    if (!env.X402_FACILITATOR_URL && !env.X402_FEE_PAYER_KEYPAIR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['X402_FEE_PAYER_KEYPAIR'],
        message: 'required when X402_FACILITATOR_URL is not set (own facilitator, ADR 0018)',
      });
    }
    if (env.HELIUS_API_KEY && !env.HELIUS_API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HELIUS_API_URL'],
        message: 'required when HELIUS_API_KEY is set',
      });
    }
  });

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  const observability = parseObservabilityEnv(process.env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  if (!parsed.success || !observability.ok) {
    throw new Error(`Invalid compliance-api environment:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  return { env: parsed.data, observability: observability.config };
}

const { env, observability } = loadEnv();

export const config = {
  port: env.COMPLIANCE_API_PORT,
  metricsPort: env.COMPLIANCE_METRICS_PORT,
  nodeEnv: env.NODE_ENV,
  observability,
  corsOrigins: env.CORS_ORIGINS,
  database: {
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY,
    apiVersion: env.STRIPE_API_VERSION,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY,
  },
  mppAuthority: {
    keypairBase58: env.MPP_AUTHORITY_KEYPAIR_BASE58,
  },
  mpp: {
    secretKey: env.MPP_SECRET_KEY,
    realm: env.MPP_REALM,
    reportPriceCents: env.MPP_REPORT_PRICE_CENTS,
    reportCurrency: env.MPP_REPORT_CURRENCY,
  },
  solana: {
    rpcUrl: env.SOLANA_RPC_URL,
    verifierProgram: env.VERIFIER_PROGRAM,
  },
  x402: {
    network: env.X402_NETWORK,
    paymentMint: env.X402_PAYMENT_MINT,
    publisherWallet: env.X402_PUBLISHER_WALLET,
    reportPrice: env.X402_REPORT_PRICE,
    facilitator: env.X402_FACILITATOR_URL
      ? ({ mode: 'remote', url: env.X402_FACILITATOR_URL, token: env.X402_FACILITATOR_TOKEN } as const)
      : ({ mode: 'self', feePayerKeypair: env.X402_FEE_PAYER_KEYPAIR! } as const),
    databaseUrl: env.DATABASE_URL,
    idempotencyTtlSeconds: env.X402_IDEMPOTENCY_TTL_SECONDS,
  },
  helius:
    env.HELIUS_API_KEY && env.HELIUS_API_URL
      ? { apiKey: env.HELIUS_API_KEY, apiUrl: env.HELIUS_API_URL.replace(/\/+$/, '') }
      : null,
  watcher: {
    intervalMs: env.COMPLIANCE_WATCHER_INTERVAL_MS,
    mintAllowList: env.COMPLIANCE_WATCHER_MINTS ?? [],
    stripeReconcileDelayMs: env.COMPLIANCE_STRIPE_RECONCILE_DELAY_MS,
  },
  alerts: {
    errors: env.COMPLIANCE_ALERT_ERRORS,
    errorWindowSeconds: env.COMPLIANCE_ALERT_ERROR_WINDOW_SECONDS,
    databaseDownSeconds: env.COMPLIANCE_ALERT_DB_DOWN_SECONDS,
  },
} as const;
