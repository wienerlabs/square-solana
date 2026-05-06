import dotenv from 'dotenv';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  port: parseInt(optionalEnv('COMPLIANCE_API_PORT', '3002'), 10),
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  logLevel: optionalEnv('LOG_LEVEL', 'info'),
  policyServiceUrl: optionalEnv('POLICY_SERVICE_URL', 'http://localhost:3001'),
  database: {
    host: requireEnv('POSTGRES_HOST'),
    port: parseInt(optionalEnv('POSTGRES_PORT', '5432'), 10),
    user: requireEnv('POSTGRES_USER'),
    password: requireEnv('POSTGRES_PASSWORD'),
    database: requireEnv('POSTGRES_DB'),
  },
  stripe: {
    secretKey: requireEnv('STRIPE_SECRET_KEY'),
    apiVersion: optionalEnv('STRIPE_API_VERSION', '2026-03-04.preview'),
    /// Stripe webhook signing secret (whsec_xxx). The signature on every
    /// webhook payload is verified against this; without it the endpoint
    /// would accept arbitrary attacker-shaped events. Optional at process
    /// boot so the compliance-api can start without Stripe webhooks
    /// configured (the /api/v1/mpp/webhook route returns 503 in that case);
    /// production deployments MUST set the value.
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    /// Stripe publishable key (pk_test_… / pk_live_…). Surfaced to the
    /// dashboard via /api/v1/compliance/mpp/public-config so the browser
    /// can mount Stripe Elements without bundling the key. Optional —
    /// when unset the dashboard's MPP card hides the card-input UI and
    /// shows an "MPP unavailable" hint instead.
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  },
  /// Ed25519 keypair the compliance-api uses to attest verified Stripe
  /// PaymentIntents to the on-chain verifier. The public key is the value
  /// the verifier program hardcodes as `MPP_AUTHORITY_PUBKEY` (Adım 8c).
  /// Stored as a 64-byte base58 secret, same encoding as Solana keypairs,
  /// so the same KMS-managed Solana key can serve both purposes if desired.
  /// Optional at boot for dev parity with stripe.webhookSecret above; the
  /// /verified-payment endpoint returns 503 when unset.
  mppAuthority: {
    keypairBase58: process.env.MPP_AUTHORITY_KEYPAIR_BASE58 ?? '',
  },
  mpp: {
    secretKey: requireEnv('MPP_SECRET_KEY'),
    realm: optionalEnv('MPP_REALM', 'aperture-compliance'),
  },
  light: {
    rpcUrl: optionalEnv('LIGHT_RPC_URL', ''),
    compressedMint: optionalEnv('COMPRESSED_ATTESTATION_MINT', ''),
    payerPrivateKey: optionalEnv('LIGHT_PAYER_PRIVATE_KEY', ''),
  },
  /// Helius credentials power the unattested-payment watcher. Without an
  /// API key the watcher logs a one-time warning and stays idle so the
  /// rest of the compliance-api keeps working; an explicit failure mode
  /// would block startup which we want to avoid in dev / CI.
  helius: {
    apiKey: process.env.HELIUS_API_KEY ?? '',
    network: (process.env.HELIUS_NETWORK ?? 'devnet').toLowerCase(),
  },
  watcher: {
    /// Polling cadence in milliseconds. Lower values catch unattested
    /// payments faster but raise Helius RPC pressure linearly. 15 s keeps
    /// us well within the free-tier rate budget.
    intervalMs: parseInt(optionalEnv('COMPLIANCE_WATCHER_INTERVAL_MS', '15000'), 10),
    /// Comma-separated mint allow list. Empty means "watch every SPL
    /// transfer Helius returns" - useful when the operator policy uses an
    /// unusual mint, but generates more reconcile noise.
    mintAllowList: (process.env.COMPLIANCE_WATCHER_MINTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /// Stripe reconcile delay (ms) - how long after a verified Stripe
    /// PaymentIntent lands we wait before checking proof_records for a
    /// matching anchor. The agent / dashboard usually anchors within a
    /// few seconds; 90 s gives slow paths room without dragging out the
    /// detection window.
    stripeReconcileDelayMs: parseInt(
      optionalEnv('COMPLIANCE_STRIPE_RECONCILE_DELAY_MS', '90000'),
      10,
    ),
  },
  solana: {
    rpcUrl: optionalEnv('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  },
} as const;
