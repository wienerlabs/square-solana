// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da geçersiz
// değerde servis açılmaz. Varsayılan değer yoktur. Log, hazırlık ve alarm webhook'u değişkenleri servislerde
// ortaktır (`@squaresdk/solana-observability`). Program kimlikleri veritabanının `programs` tablosundan
// okunur.
import { parseObservabilityEnv, type ObservabilityConfig } from '@squaresdk/solana-observability';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const u64 = nonEmpty.regex(/^(0|[1-9][0-9]{0,19})$/, 'u64 ondalık bekleniyor').transform(BigInt);
const port = int(1, 65_535);
const httpUrl = z.url({ protocol: /^https?$/ });

const EnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  KEEPER_RPC_URLS: nonEmpty
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(httpUrl).min(1)),
  KEEPER_RPC_TIMEOUT_MS: int(1),
  KEEPER_RPC_COOLDOWN_MS: int(0),
  /** Keeper cüzdanının gizli anahtarı (64 bayt, base58). Ücreti alır, işlem ücretini ve rent'i öder. */
  KEEPER_SECRET_KEY: nonEmpty,
  /** `/health` ve `/ready`. */
  KEEPER_PORT: port,
  /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
  KEEPER_METRICS_PORT: port,
  KEEPER_POLL_INTERVAL_MS: int(1),
  /** Gönderilen tx'in onay durumunun yoklanma aralığı (websocket gerektirmez). */
  KEEPER_CONFIRM_POLL_MS: int(1),
  /** Bir turda değerlendirilen en fazla job. */
  KEEPER_BATCH_SIZE: int(1, 1_000),
  /** Bekletilen job'un ilk yeniden deneme aralığı; her tekrarda ikiye katlanır. */
  KEEPER_BACKOFF_BASE_SECONDS: int(1),
  KEEPER_BACKOFF_MAX_SECONDS: int(1),
  /** 1 SOL'ün settlement mint'inin taban birimindeki karşılığı (ör. USDC, 1 SOL = 150 USD: 150000000). */
  KEEPER_MINT_UNITS_PER_SOL: u64,
  /** Keeper ücretinin maliyeti aşması gereken pay (baz puan); 0 başa baş. */
  KEEPER_MIN_MARGIN_BPS: int(0, 100_000),
  /** Priority fee: job'un yazılabilir hesaplarının son ücretlerinin bu yüzdeliği. */
  KEEPER_PRIORITY_FEE_PERCENTILE: int(0, 100),
  /** Priority fee üst sınırı (mikro-lamport / CU). */
  KEEPER_MAX_COMPUTE_UNIT_PRICE: u64,
  /** `keeper_low_balance` alarmı: keeper'ın SOL bakiyesi bu değerin altında. */
  KEEPER_ALERT_MIN_BALANCE_LAMPORTS: u64,
  /** `keeper_stalled` alarmı: son başarılı turun üstünden bu kadar saniye geçti. */
  KEEPER_ALERT_STALL_SECONDS: int(1),
  /** `keeper_backlog` alarmı: finalize edilebilir bir job bu kadar saniyeden uzun süredir bekliyor. */
  KEEPER_ALERT_DUE_SECONDS: int(1),
  /** `keeper_errors` alarmı: başarısız finalize ve tur hataları bu değerin üstüne ... */
  KEEPER_ALERT_ERRORS: int(0),
  /** ... bu kadar saniyelik pencerede çıkarsa çalar. */
  KEEPER_ALERT_ERROR_WINDOW_SECONDS: int(1),
});

export interface Economics {
  readonly mintUnitsPerSol: bigint;
  readonly minMarginBps: number;
  readonly priorityFeePercentile: number;
  readonly maxComputeUnitPrice: bigint;
}

export interface KeeperConfig {
  readonly databaseUrl: string;
  readonly rpc: { readonly urls: readonly string[]; readonly timeoutMs: number; readonly cooldownMs: number };
  readonly keeper: Keypair;
  readonly port: number;
  readonly metricsPort: number;
  readonly pollIntervalMs: number;
  readonly confirmPollMs: number;
  readonly batchSize: number;
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  readonly economics: Economics;
  readonly alerts: {
    readonly minBalanceLamports: bigint;
    readonly stallSeconds: number;
    readonly dueSeconds: number;
    readonly errors: number;
    readonly errorWindowSeconds: number;
  };
  readonly observability: ObservabilityConfig;
}

function keypair(secret: string): Keypair | string {
  try {
    const bytes = bs58.decode(secret);
    return bytes.length === 64 ? Keypair.fromSecretKey(bytes) : '64 baytlık base58 gizli anahtar bekleniyor';
  } catch {
    return 'base58 gizli anahtar bekleniyor';
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): KeeperConfig {
  const parsed = EnvSchema.safeParse(env);
  const observability = parseObservabilityEnv(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  let keeper: Keypair | null = null;
  if (parsed.success) {
    const e = parsed.data;
    if (e.KEEPER_PORT === e.KEEPER_METRICS_PORT) problems.push('KEEPER_METRICS_PORT: KEEPER_PORT ile aynı olamaz');
    if (e.KEEPER_BACKOFF_MAX_SECONDS < e.KEEPER_BACKOFF_BASE_SECONDS) {
      problems.push('KEEPER_BACKOFF_MAX_SECONDS: KEEPER_BACKOFF_BASE_SECONDS’tan küçük olamaz');
    }
    if (e.KEEPER_MINT_UNITS_PER_SOL === 0n) problems.push('KEEPER_MINT_UNITS_PER_SOL: sıfır olamaz');
    const decoded = keypair(e.KEEPER_SECRET_KEY);
    // Gizli anahtarın kendisi hata mesajına yazılmaz.
    if (typeof decoded === 'string') problems.push(`KEEPER_SECRET_KEY: ${decoded}`);
    else keeper = decoded;
  }
  if (!parsed.success || !observability.ok || problems.length > 0 || !keeper) {
    throw new Error(`Geçersiz keeper ortamı:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  const e = parsed.data;
  return Object.freeze({
    databaseUrl: e.DATABASE_URL,
    rpc: Object.freeze({
      urls: Object.freeze([...e.KEEPER_RPC_URLS]),
      timeoutMs: e.KEEPER_RPC_TIMEOUT_MS,
      cooldownMs: e.KEEPER_RPC_COOLDOWN_MS,
    }),
    keeper,
    port: e.KEEPER_PORT,
    metricsPort: e.KEEPER_METRICS_PORT,
    pollIntervalMs: e.KEEPER_POLL_INTERVAL_MS,
    confirmPollMs: e.KEEPER_CONFIRM_POLL_MS,
    batchSize: e.KEEPER_BATCH_SIZE,
    backoff: Object.freeze({ baseSeconds: e.KEEPER_BACKOFF_BASE_SECONDS, maxSeconds: e.KEEPER_BACKOFF_MAX_SECONDS }),
    economics: Object.freeze({
      mintUnitsPerSol: e.KEEPER_MINT_UNITS_PER_SOL,
      minMarginBps: e.KEEPER_MIN_MARGIN_BPS,
      priorityFeePercentile: e.KEEPER_PRIORITY_FEE_PERCENTILE,
      maxComputeUnitPrice: e.KEEPER_MAX_COMPUTE_UNIT_PRICE,
    }),
    alerts: Object.freeze({
      minBalanceLamports: e.KEEPER_ALERT_MIN_BALANCE_LAMPORTS,
      stallSeconds: e.KEEPER_ALERT_STALL_SECONDS,
      dueSeconds: e.KEEPER_ALERT_DUE_SECONDS,
      errors: e.KEEPER_ALERT_ERRORS,
      errorWindowSeconds: e.KEEPER_ALERT_ERROR_WINDOW_SECONDS,
    }),
    observability: observability.config,
  });
}
