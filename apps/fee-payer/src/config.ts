// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da geçersiz
// değerde servis açılmaz. Varsayılan değer yoktur; yalnızca izinli talimat listesi verilmezse ADR 0019'deki
// varsayılan listedir (`DEFAULT_ALLOWED_INSTRUCTIONS`). Log, hazırlık ve alarm webhook'u değişkenleri servislerde
// ortaktır (`@squaresdk/solana-observability`). Program kimlikleri veritabanının `programs` tablosundan okunur.
import { parseObservabilityEnv, type ObservabilityConfig } from '@squaresdk/solana-observability';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import { DEFAULT_ALLOWED_INSTRUCTIONS, parseAllowedInstructions } from './catalog.js';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const port = int(1, 65_535);
const httpUrl = z.url({ protocol: /^https?$/ });
const u64 = nonEmpty.regex(/^(0|[1-9][0-9]{0,19})$/, 'u64 ondalık bekleniyor').transform(BigInt);
const lamports = u64.refine((value) => value > 0n && value < 2n ** 64n, 'pozitif u64 bekleniyor');
const commaList = <T extends z.ZodType<string, string>>(item: T) =>
  nonEmpty
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).min(1));
/** Boş bırakılan isteğe bağlı değişken verilmemiş sayılır. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

/** Solana'nın bir tx için izin verdiği en yüksek compute unit sınırı. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

const EnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  FEE_PAYER_PORT: port,
  /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
  FEE_PAYER_METRICS_PORT: port,
  /** Tarayıcıdan çağrılara izin verilen origin'ler (virgülle). */
  CORS_ORIGINS: commaList(httpUrl),
  FEE_PAYER_TRUST_PROXY_HOPS: int(0, 10),
  /** İstek gövdesi sınırı (JSON, bayt); base64 tx 1232 baytın ~4/3'ü. */
  FEE_PAYER_JSON_MAX_BYTES: int(1),

  FEE_PAYER_RPC_URLS: commaList(httpUrl),
  FEE_PAYER_RPC_TIMEOUT_MS: int(1),
  FEE_PAYER_RPC_COOLDOWN_MS: int(0),

  /** Sponsor anahtarı: 64 baytlık Ed25519 gizli anahtarı, base58 (platformun gizli değişkeni; ADR 0019). */
  FEE_PAYER_SECRET_KEY: nonEmpty,

  /** İzinli talimatlar `<program>:<talimat>` (virgülle); verilmezse ADR 0019'nin varsayılan listesi. */
  FEE_PAYER_ALLOWED_INSTRUCTIONS: optional(nonEmpty),
  /** Priority fee tavanı (mikro-lamport / CU). */
  FEE_PAYER_MAX_COMPUTE_UNIT_PRICE: u64,
  /** Tx başına compute unit sınırının tavanı. */
  FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT: int(1, MAX_COMPUTE_UNIT_LIMIT),
  /** Tek tx'in en yüksek maliyeti (ücret + rent, lamport). */
  FEE_PAYER_MAX_LAMPORTS_PER_TX: lamports,
  /** Kullanıcı (cüzdan) başına günlük bütçe (UTC günü, lamport). */
  FEE_PAYER_USER_DAILY_LAMPORTS: lamports,
  /** Bütün kullanıcıların günlük toplam bütçesi (lamport). */
  FEE_PAYER_GLOBAL_DAILY_LAMPORTS: lamports,

  FEE_PAYER_RATE_LIMIT_WINDOW_SECONDS: int(1),
  /** Pencere başına sponsor isteği (kullanıcı başına). */
  FEE_PAYER_RATE_LIMIT: int(1),

  /** `fee_payer_balance_low` alarmı: sponsor bakiyesi bunun altına düşerse çalar (lamport). */
  FEE_PAYER_MIN_BALANCE_LAMPORTS: lamports,
  /** `fee_payer_errors` alarmı: iç hata sayısı bu değerin üstüne ... */
  FEE_PAYER_ALERT_ERRORS: int(0),
  /** ... bu kadar saniyelik pencerede çıkarsa çalar. */
  FEE_PAYER_ALERT_ERROR_WINDOW_SECONDS: int(1),
});

export interface FeePayerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly metricsPort: number;
  readonly corsOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly jsonMaxBytes: number;
  readonly rpc: { readonly urls: readonly string[]; readonly timeoutMs: number; readonly cooldownMs: number };
  readonly sponsor: Keypair;
  readonly allowedInstructions: ReadonlySet<string>;
  readonly limits: {
    readonly maxComputeUnitPrice: bigint;
    readonly maxComputeUnitLimit: number;
    readonly maxLamportsPerTx: bigint;
    readonly userDailyLamports: bigint;
    readonly globalDailyLamports: bigint;
  };
  readonly rateLimit: { readonly windowSeconds: number; readonly limit: number };
  readonly alerts: {
    readonly minBalanceLamports: bigint;
    readonly errors: number;
    readonly errorWindowSeconds: number;
  };
  readonly observability: ObservabilityConfig;
}

/** 64 baytlık base58 gizli anahtar; bozuk değerin içeriği hata mesajına yazılmaz. */
function parseSecretKey(value: string): Keypair | string {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value.trim());
  } catch {
    return 'base58 değil';
  }
  if (bytes.length !== 64) return `64 bayt olmalı, ${bytes.length} bayt`;
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    return 'gizli anahtar ile açık anahtar tutarsız';
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): FeePayerConfig {
  const parsed = EnvSchema.safeParse(env);
  const observability = parseObservabilityEnv(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  let sponsor: Keypair | null = null;
  let allowed: ReadonlySet<string> | null = null;
  if (parsed.success) {
    const e = parsed.data;
    if (e.FEE_PAYER_PORT === e.FEE_PAYER_METRICS_PORT) {
      problems.push('FEE_PAYER_METRICS_PORT: FEE_PAYER_PORT ile aynı olamaz');
    }
    const key = parseSecretKey(e.FEE_PAYER_SECRET_KEY);
    if (typeof key === 'string') problems.push(`FEE_PAYER_SECRET_KEY: ${key}`);
    else sponsor = key;
    try {
      allowed = parseAllowedInstructions(e.FEE_PAYER_ALLOWED_INSTRUCTIONS ?? DEFAULT_ALLOWED_INSTRUCTIONS.join(','));
    } catch (error) {
      problems.push(`FEE_PAYER_ALLOWED_INSTRUCTIONS: ${(error as Error).message}`);
    }
    if (e.FEE_PAYER_MAX_LAMPORTS_PER_TX > e.FEE_PAYER_USER_DAILY_LAMPORTS) {
      problems.push('FEE_PAYER_MAX_LAMPORTS_PER_TX: kullanıcının günlük bütçesinden büyük olamaz');
    }
    if (e.FEE_PAYER_USER_DAILY_LAMPORTS > e.FEE_PAYER_GLOBAL_DAILY_LAMPORTS) {
      problems.push('FEE_PAYER_USER_DAILY_LAMPORTS: toplam günlük bütçeden büyük olamaz');
    }
  }
  if (!parsed.success || !observability.ok || problems.length > 0 || !sponsor || !allowed) {
    throw new Error(`Geçersiz fee payer ortamı:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  const e = parsed.data;
  return Object.freeze({
    databaseUrl: e.DATABASE_URL,
    port: e.FEE_PAYER_PORT,
    metricsPort: e.FEE_PAYER_METRICS_PORT,
    corsOrigins: Object.freeze([...e.CORS_ORIGINS]),
    trustProxyHops: e.FEE_PAYER_TRUST_PROXY_HOPS,
    jsonMaxBytes: e.FEE_PAYER_JSON_MAX_BYTES,
    rpc: Object.freeze({
      urls: Object.freeze([...e.FEE_PAYER_RPC_URLS]),
      timeoutMs: e.FEE_PAYER_RPC_TIMEOUT_MS,
      cooldownMs: e.FEE_PAYER_RPC_COOLDOWN_MS,
    }),
    sponsor,
    allowedInstructions: allowed,
    limits: Object.freeze({
      maxComputeUnitPrice: e.FEE_PAYER_MAX_COMPUTE_UNIT_PRICE,
      maxComputeUnitLimit: e.FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT,
      maxLamportsPerTx: e.FEE_PAYER_MAX_LAMPORTS_PER_TX,
      userDailyLamports: e.FEE_PAYER_USER_DAILY_LAMPORTS,
      globalDailyLamports: e.FEE_PAYER_GLOBAL_DAILY_LAMPORTS,
    }),
    rateLimit: Object.freeze({ windowSeconds: e.FEE_PAYER_RATE_LIMIT_WINDOW_SECONDS, limit: e.FEE_PAYER_RATE_LIMIT }),
    alerts: Object.freeze({
      minBalanceLamports: e.FEE_PAYER_MIN_BALANCE_LAMPORTS,
      errors: e.FEE_PAYER_ALERT_ERRORS,
      errorWindowSeconds: e.FEE_PAYER_ALERT_ERROR_WINDOW_SECONDS,
    }),
    observability: observability.config,
  });
}
