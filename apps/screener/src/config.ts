// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da geçersiz
// değerde servis açılmaz. Varsayılan değer yoktur. Log, hazırlık ve alarm webhook'u değişkenleri servislerde
// ortaktır (`@squaresdk/solana-observability`). Program kimlikleri ortamdan değil, veritabanının `programs`
// tablosundan okunur (seed yazar; `src/programs.ts`). Screener authority anahtarı repoda değil, secret
// store'dadır: ortam değişkeni ya da bağlanan secret dosyasının yolu (README "Anahtar saklama").
import { parseObservabilityEnv, type ObservabilityConfig } from '@squaresdk/solana-observability';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const port = int(1, 65_535);
const httpUrl = z.url({ protocol: /^https?$/ });
const httpsUrl = z.url({ protocol: /^https$/ });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, '64 küçük harf hex bekleniyor');
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
/** Sondaki eğik çizgi olmadan. */
const baseUrl = (schema: z.ZodType<string, string>) => schema.transform((value) => value.replace(/\/+$/, ''));

const EnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  /** API, `/health` ve `/ready`. */
  SCREENER_PORT: port,
  /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
  SCREENER_METRICS_PORT: port,
  /** İzinli API anahtarlarının SHA-256'sı (virgülle); anahtarın kendisi ortamda tutulmaz. */
  SCREENER_API_KEY_SHA256: commaList(sha256Hex),
  /** İstek gövdesinin sınırı (JSON, bayt). */
  SCREENER_JSON_MAX_BYTES: int(1),
  SCREENER_RATE_LIMIT_WINDOW_SECONDS: int(1),
  /** Pencere başına tarama isteği (anahtar başına; her biri bir tx'tir). */
  SCREENER_RATE_LIMIT_SCREEN: int(1),
  /** Pencere başına okuma isteği (anahtar başına). */
  SCREENER_RATE_LIMIT_READ: int(1),

  /** Solana RPC uçları (virgülle); ilki tercih edilir, hata veren uç süre boyunca atlanır. */
  SCREENER_RPC_URLS: commaList(httpUrl),
  SCREENER_RPC_TIMEOUT_MS: int(1),
  SCREENER_RPC_COOLDOWN_MS: int(0),
  /** `record_screening` tx'inin priority fee'si (mikro-lamport / CU). */
  SCREENER_COMPUTE_UNIT_PRICE: nonEmpty.regex(/^(0|[1-9][0-9]{0,19})$/, 'u64 ondalık bekleniyor').transform(BigInt),
  /** Gönderilen tx'in durumunun sorgulanma aralığı. */
  SCREENER_CONFIRM_POLL_MS: int(1),
  /** Screener authority keypair'i: solana-keygen JSON'u (64 baytlık dizi). PATH ile birlikte verilemez. */
  SCREENER_AUTHORITY_KEYPAIR: optional(nonEmpty),
  /** Screener authority keypair dosyasının yolu (bağlanan secret dosyası). */
  SCREENER_AUTHORITY_KEYPAIR_PATH: optional(nonEmpty),

  /** OFAC SDN listesinin XML adresi (`SDN.XML`). */
  SCREENER_OFAC_SDN_URL: httpsUrl,
  /** Listenin yeniden indirilme aralığı. */
  SCREENER_OFAC_REFRESH_SECONDS: int(1),
  /** Son başarılı indirmenin üstünden bu kadar saniye geçerse liste bayat sayılır ve tarama yapılmaz. */
  SCREENER_OFAC_MAX_AGE_SECONDS: int(1),
  SCREENER_OFAC_TIMEOUT_MS: int(1),
  /** İndirilen listenin en büyük boyutu (bayt). */
  SCREENER_OFAC_MAX_BYTES: int(1),

  /** Chainalysis sanctions API anahtarı (ADR 0020). Verilmezse yalnızca OFAC listesi taranır. */
  SCREENER_CHAINALYSIS_API_KEY: optional(nonEmpty),
  /** Yukarıdaki verilince zorunlu: */
  SCREENER_CHAINALYSIS_URL: optional(baseUrl(httpsUrl)),
  SCREENER_CHAINALYSIS_TIMEOUT_MS: optional(int(1)),

  /** TTL yenileme döngüsünün aralığı. */
  SCREENER_RENEW_INTERVAL_SECONDS: int(1),
  /** `expires_at`'a bu kadar saniye kalan (ya da süresi geçmiş) kayıt yeniden taranır. */
  SCREENER_RENEW_MARGIN_SECONDS: int(1),
  /** Bir koşuda yenilenen en fazla cüzdan. */
  SCREENER_RENEW_BATCH: int(1, 1000),
  /** Son bu kadar saniyede kararı yazılmış (ya da denenmiş) cüzdan yenilemede atlanır. */
  SCREENER_RENEW_RETRY_SECONDS: int(1),

  /** `screener_errors` alarmı: hata sayısı bu değerin üstüne ... */
  SCREENER_ALERT_ERRORS: int(0),
  /** ... bu kadar saniyelik pencerede çıkarsa çalar. */
  SCREENER_ALERT_ERROR_WINDOW_SECONDS: int(1),
  /** `screener_low_balance` alarmı: authority bakiyesi bu değerin altındaysa çalar (lamport). */
  SCREENER_ALERT_MIN_BALANCE_LAMPORTS: int(0),
});

export interface ChainalysisConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

export interface ScreenerConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly metricsPort: number;
  readonly apiKeySha256: readonly string[];
  readonly jsonMaxBytes: number;
  readonly rateLimit: { readonly windowSeconds: number; readonly screen: number; readonly read: number };
  readonly rpc: { readonly urls: readonly string[]; readonly timeoutMs: number; readonly cooldownMs: number };
  readonly tx: { readonly computeUnitPrice: bigint; readonly confirmPollMs: number };
  /** Anahtarın kaynağı; değer `loadAuthorityKeypair` ile okunur. */
  readonly authority:
    { readonly kind: 'inline'; readonly value: string } | { readonly kind: 'file'; readonly path: string };
  readonly ofac: {
    readonly url: string;
    readonly refreshSeconds: number;
    readonly maxAgeSeconds: number;
    readonly timeoutMs: number;
    readonly maxBytes: number;
  };
  /** Sağlayıcı kapalıysa null. */
  readonly chainalysis: ChainalysisConfig | null;
  readonly renewal: {
    readonly intervalSeconds: number;
    readonly marginSeconds: number;
    readonly batch: number;
    readonly retrySeconds: number;
  };
  readonly alerts: {
    readonly errors: number;
    readonly errorWindowSeconds: number;
    readonly minBalanceLamports: number;
  };
  readonly observability: ObservabilityConfig;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ScreenerConfig {
  const parsed = EnvSchema.safeParse(env);
  const observability = parseObservabilityEnv(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  if (parsed.success) {
    const e = parsed.data;
    if (e.SCREENER_PORT === e.SCREENER_METRICS_PORT) {
      problems.push('SCREENER_METRICS_PORT: SCREENER_PORT ile aynı olamaz');
    }
    if ((e.SCREENER_AUTHORITY_KEYPAIR === undefined) === (e.SCREENER_AUTHORITY_KEYPAIR_PATH === undefined)) {
      problems.push('SCREENER_AUTHORITY_KEYPAIR: SCREENER_AUTHORITY_KEYPAIR ya da _PATH, yalnızca biri verilmeli');
    }
    if (e.SCREENER_CHAINALYSIS_API_KEY !== undefined) {
      for (const key of ['SCREENER_CHAINALYSIS_URL', 'SCREENER_CHAINALYSIS_TIMEOUT_MS'] as const) {
        if (e[key] === undefined) problems.push(`${key}: SCREENER_CHAINALYSIS_API_KEY verilince zorunlu`);
      }
    }
    if (e.SCREENER_OFAC_MAX_AGE_SECONDS <= e.SCREENER_OFAC_REFRESH_SECONDS) {
      problems.push('SCREENER_OFAC_MAX_AGE_SECONDS: SCREENER_OFAC_REFRESH_SECONDS değerinden büyük olmalı');
    }
  }
  if (!parsed.success || !observability.ok || problems.length > 0) {
    throw new Error(`Geçersiz screener ortamı:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  const e = parsed.data;
  return Object.freeze({
    databaseUrl: e.DATABASE_URL,
    port: e.SCREENER_PORT,
    metricsPort: e.SCREENER_METRICS_PORT,
    apiKeySha256: Object.freeze([...new Set(e.SCREENER_API_KEY_SHA256)]),
    jsonMaxBytes: e.SCREENER_JSON_MAX_BYTES,
    rateLimit: Object.freeze({
      windowSeconds: e.SCREENER_RATE_LIMIT_WINDOW_SECONDS,
      screen: e.SCREENER_RATE_LIMIT_SCREEN,
      read: e.SCREENER_RATE_LIMIT_READ,
    }),
    rpc: Object.freeze({
      urls: Object.freeze([...e.SCREENER_RPC_URLS]),
      timeoutMs: e.SCREENER_RPC_TIMEOUT_MS,
      cooldownMs: e.SCREENER_RPC_COOLDOWN_MS,
    }),
    tx: Object.freeze({ computeUnitPrice: e.SCREENER_COMPUTE_UNIT_PRICE, confirmPollMs: e.SCREENER_CONFIRM_POLL_MS }),
    authority: Object.freeze(
      e.SCREENER_AUTHORITY_KEYPAIR !== undefined
        ? { kind: 'inline' as const, value: e.SCREENER_AUTHORITY_KEYPAIR }
        : { kind: 'file' as const, path: e.SCREENER_AUTHORITY_KEYPAIR_PATH! },
    ),
    ofac: Object.freeze({
      url: e.SCREENER_OFAC_SDN_URL,
      refreshSeconds: e.SCREENER_OFAC_REFRESH_SECONDS,
      maxAgeSeconds: e.SCREENER_OFAC_MAX_AGE_SECONDS,
      timeoutMs: e.SCREENER_OFAC_TIMEOUT_MS,
      maxBytes: e.SCREENER_OFAC_MAX_BYTES,
    }),
    chainalysis:
      e.SCREENER_CHAINALYSIS_API_KEY === undefined
        ? null
        : Object.freeze({
            url: e.SCREENER_CHAINALYSIS_URL!,
            apiKey: e.SCREENER_CHAINALYSIS_API_KEY,
            timeoutMs: e.SCREENER_CHAINALYSIS_TIMEOUT_MS!,
          }),
    renewal: Object.freeze({
      intervalSeconds: e.SCREENER_RENEW_INTERVAL_SECONDS,
      marginSeconds: e.SCREENER_RENEW_MARGIN_SECONDS,
      batch: e.SCREENER_RENEW_BATCH,
      retrySeconds: e.SCREENER_RENEW_RETRY_SECONDS,
    }),
    alerts: Object.freeze({
      errors: e.SCREENER_ALERT_ERRORS,
      errorWindowSeconds: e.SCREENER_ALERT_ERROR_WINDOW_SECONDS,
      minBalanceLamports: e.SCREENER_ALERT_MIN_BALANCE_LAMPORTS,
    }),
    observability: observability.config,
  });
}
