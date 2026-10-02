import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/// Every deployment-dependent value comes from the environment and is
/// validated at boot; nothing falls back to a built-in URL, network, address,
/// port or price. Variables marked optional switch a feature on when present
/// (the corresponding route answers 503 while it is off).

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
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']),
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

    X402_NETWORK: z.enum(['solana', 'solana-devnet']),
    X402_PAYMENT_MINT: base58Pubkey,
    X402_PUBLISHER_WALLET: base58Pubkey,
    /// Report price in the payment mint's base units.
    X402_REPORT_PRICE: intFromEnv(1),

    /// Enables the unattested-payment watcher.
    HELIUS_API_KEY: optionalSecret,
    /// Enhanced Transactions API base URL for the cluster being watched.
    HELIUS_API_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    COMPLIANCE_WATCHER_INTERVAL_MS: intFromEnv(5_000),
    /// Mint allow list; unset watches every SPL transfer Helius returns.
    COMPLIANCE_WATCHER_MINTS: commaList(base58Pubkey).optional(),
    COMPLIANCE_STRIPE_RECONCILE_DELAY_MS: intFromEnv(0),
  })
  .superRefine((env, ctx) => {
    if (env.HELIUS_API_KEY && !env.HELIUS_API_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HELIUS_API_URL'],
        message: 'required when HELIUS_API_KEY is set',
      });
    }
  });

function loadEnv(): z.infer<typeof EnvSchema> {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid compliance-api environment:\n${problems}`);
  }
  return parsed.data;
}

const env = loadEnv();

export const config = {
  port: env.COMPLIANCE_API_PORT,
  nodeEnv: env.NODE_ENV,
  logLevel: env.LOG_LEVEL,
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
} as const;
