// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da geçersiz
// değerde servis açılmaz. Varsayılan değer yoktur. Log, hazırlık ve alarm webhook'u değişkenleri servislerde
// ortaktır (`@squaresdk/solana-observability`). Program kimlikleri ortamdan değil, veritabanının `programs`
// tablosundan okunur (seed yazar; `src/programs.ts`).
import { parseObservabilityEnv, type ObservabilityConfig } from '@squaresdk/solana-observability';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const port = int(1, 65_535);
const httpUrl = z.url({ protocol: /^https?$/ });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '64 küçük harf hex bekleniyor');
/** Boş bırakılan isteğe bağlı değişken verilmemiş sayılır. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const EnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  /** Solana RPC uçları (virgülle); ilki tercih edilir, hata veren uç süre boyunca atlanır. */
  INDEXER_RPC_URLS: nonEmpty
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(httpUrl).min(1)),
  INDEXER_RPC_TIMEOUT_MS: int(1),
  INDEXER_RPC_COOLDOWN_MS: int(0),
  /** Webhook, `/health` ve `/ready`. */
  INDEXER_PORT: port,
  /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
  INDEXER_METRICS_PORT: port,
  /** Kesinleşmiş imzaların taranma aralığı. */
  INDEXER_POLL_INTERVAL_MS: int(1),
  /** `getSignaturesForAddress` sayfa boyu (RPC sınırı 1000). */
  INDEXER_SIGNATURE_PAGE_SIZE: int(1, 1000),
  /** Zincir ↔ veritabanı uzlaştırmasının aralığı. */
  INDEXER_RECONCILE_INTERVAL_SECONDS: int(1),
  /**
   * Helius webhook'unun `Authorization` başlığının SHA-256'sı. Verilmezse webhook ucu kapalıdır; indexer
   * yalnızca RPC taramasıyla çalışır.
   */
  INDEXER_WEBHOOK_AUTH_SHA256: optional(sha256Hex),
  /** Webhook gövdesinin en büyük boyutu (bayt). */
  INDEXER_WEBHOOK_MAX_BODY_BYTES: optional(int(1)),
  /** Kesinleşmeyi bekleyen en fazla webhook imzası; dolunca yenileri taramaya bırakılır. */
  INDEXER_WEBHOOK_MAX_PENDING: optional(int(1)),
  /** Bu süre içinde kesinleşmeyen webhook imzası bırakılır (tarama yine bulur). */
  INDEXER_WEBHOOK_PENDING_TTL_SECONDS: optional(int(1)),
  /** `indexer_stalled` alarmı: son başarılı taramanın üstünden bu kadar saniye geçerse çalar. */
  INDEXER_ALERT_STALL_SECONDS: int(1),
  /** `indexer_reconcile_drift` alarmı: son uzlaştırmanın bulduğu sapma bu değerin üstündeyse çalar. */
  INDEXER_ALERT_DRIFT: int(0),
  /** `indexer_errors` alarmı: işleme hatası sayısı bu değerin üstüne ... */
  INDEXER_ALERT_ERRORS: int(0),
  /** ... bu kadar saniyelik pencerede çıkarsa çalar. */
  INDEXER_ALERT_ERROR_WINDOW_SECONDS: int(1),
});

export interface WebhookConfig {
  readonly authSha256: string;
  readonly maxBodyBytes: number;
  readonly maxPending: number;
  readonly pendingTtlSeconds: number;
}

export interface AlertThresholds {
  readonly stallSeconds: number;
  readonly drift: number;
  readonly errors: number;
  readonly errorWindowSeconds: number;
}

export interface IndexerConfig {
  readonly databaseUrl: string;
  readonly rpc: { readonly urls: readonly string[]; readonly timeoutMs: number; readonly cooldownMs: number };
  readonly port: number;
  readonly metricsPort: number;
  readonly pollIntervalMs: number;
  readonly signaturePageSize: number;
  readonly reconcileIntervalSeconds: number;
  /** Webhook kapalıysa null. */
  readonly webhook: WebhookConfig | null;
  readonly alerts: AlertThresholds;
  readonly observability: ObservabilityConfig;
}

const WEBHOOK_KEYS = [
  'INDEXER_WEBHOOK_MAX_BODY_BYTES',
  'INDEXER_WEBHOOK_MAX_PENDING',
  'INDEXER_WEBHOOK_PENDING_TTL_SECONDS',
] as const;

export function loadConfig(env: Readonly<Record<string, string | undefined>>): IndexerConfig {
  const parsed = EnvSchema.safeParse(env);
  const observability = parseObservabilityEnv(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  if (parsed.success) {
    const e = parsed.data;
    if (e.INDEXER_PORT === e.INDEXER_METRICS_PORT) problems.push('INDEXER_METRICS_PORT: INDEXER_PORT ile aynı olamaz');
    if (e.INDEXER_WEBHOOK_AUTH_SHA256 !== undefined) {
      for (const key of WEBHOOK_KEYS) {
        if (e[key] === undefined) problems.push(`${key}: INDEXER_WEBHOOK_AUTH_SHA256 verilince zorunlu`);
      }
    }
  }
  if (!parsed.success || !observability.ok || problems.length > 0) {
    throw new Error(`Geçersiz indexer ortamı:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  const e = parsed.data;
  const webhook =
    e.INDEXER_WEBHOOK_AUTH_SHA256 === undefined
      ? null
      : Object.freeze({
          authSha256: e.INDEXER_WEBHOOK_AUTH_SHA256,
          maxBodyBytes: e.INDEXER_WEBHOOK_MAX_BODY_BYTES!,
          maxPending: e.INDEXER_WEBHOOK_MAX_PENDING!,
          pendingTtlSeconds: e.INDEXER_WEBHOOK_PENDING_TTL_SECONDS!,
        });
  return Object.freeze({
    databaseUrl: e.DATABASE_URL,
    rpc: Object.freeze({
      urls: Object.freeze([...e.INDEXER_RPC_URLS]),
      timeoutMs: e.INDEXER_RPC_TIMEOUT_MS,
      cooldownMs: e.INDEXER_RPC_COOLDOWN_MS,
    }),
    port: e.INDEXER_PORT,
    metricsPort: e.INDEXER_METRICS_PORT,
    pollIntervalMs: e.INDEXER_POLL_INTERVAL_MS,
    signaturePageSize: e.INDEXER_SIGNATURE_PAGE_SIZE,
    reconcileIntervalSeconds: e.INDEXER_RECONCILE_INTERVAL_SECONDS,
    webhook,
    alerts: Object.freeze({
      stallSeconds: e.INDEXER_ALERT_STALL_SECONDS,
      drift: e.INDEXER_ALERT_DRIFT,
      errors: e.INDEXER_ALERT_ERRORS,
      errorWindowSeconds: e.INDEXER_ALERT_ERROR_WINDOW_SECONDS,
    }),
    observability: observability.config,
  });
}
