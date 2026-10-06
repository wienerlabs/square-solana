// Çalışma zamanı yapılandırması: her değer ortamdan gelir ve açılışta doğrulanır; eksik ya da geçersiz
// değerde servis açılmaz. Varsayılan değer yoktur. Log, hazırlık ve alarm webhook'u değişkenleri servislerde
// ortaktır (`@squaresdk/solana-observability`). Program kimlikleri veritabanının `programs` tablosundan,
// ağ referansı (did:aip) RPC'nin genesis hash'inden okunur.
import { parseSecretBoxKeys } from '@squaresdk/solana-hardening';
import { parseObservabilityEnv, type ObservabilityConfig } from '@squaresdk/solana-observability';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const int = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  nonEmpty.transform(Number).pipe(z.number().int().min(min).max(max));
const port = int(1, 65_535);
const httpsUrl = z.url({ protocol: /^https$/ });
const httpUrl = z.url({ protocol: /^https?$/ });
const bool = z.enum(['true', 'false']).transform((value) => value === 'true');
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

/** `agentCardUri`'nin yol kısmı: `/a/<AgentRecord>/.well-known/agent-card.json` (adres en çok 44 karakter). */
const CARD_PATH_MAX = '/a/'.length + 44 + '/.well-known/agent-card.json'.length;
/** `update_agent` / `register_agent`'ın `agent_card_uri` sınırı (registry 6001). */
const AGENT_CARD_URI_MAX = 200;
/** `submit_work`'ün `delivery_uri` sınırı (escrow 6007): `<taban>/<64 hex workHash>`. */
const DELIVERY_URI_MAX = 128;
const SECONDS_PER_DAY = 86_400;
/** Travel Rule ana anahtarı: `kimlik:base64`, anahtar 32 bayt (base64'te 44 karakter). */
const TRAVEL_RULE_KEY = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9+/]{43}=$/,
    '`kimlik:base64` bekleniyor (kimlik küçük harf, anahtar 32 bayt)',
  );
const TRAVEL_RULE_KEY_ID = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'anahtar kimliği bekleniyor');

const EnvSchema = z.object({
  DATABASE_URL: nonEmpty,
  API_PORT: port,
  /** Yalnızca iç ağdan erişilen metrik portu (`GET /metrics`). */
  API_METRICS_PORT: port,
  /** API'nin dışarıdan görünen adresi: agent card URI'leri ve OpenAPI `servers`. */
  API_PUBLIC_BASE_URL: baseUrl(httpsUrl),
  /** Tarayıcıdan çağrılara izin verilen origin'ler (virgülle). */
  CORS_ORIGINS: commaList(httpUrl),
  /** İstemci IP'si için güvenilen vekil sayısı (Railway önünde 1). */
  API_TRUST_PROXY_HOPS: int(0, 10),
  /** Okuma ve yazma isteklerinin gövde sınırı (JSON, bayt). */
  API_JSON_MAX_BYTES: int(1),

  API_RPC_URLS: commaList(httpUrl),
  API_RPC_TIMEOUT_MS: int(1),
  API_RPC_COOLDOWN_MS: int(0),

  /** Oturum mesajındaki alan adı (cüzdanın kullanıcıya gösterdiği). */
  API_AUTH_DOMAIN: z.string().regex(/^[a-z0-9.-]+(:\d+)?$/, 'alan adı bekleniyor (ör. app.example.com)'),
  API_AUTH_CHALLENGE_TTL_SECONDS: int(1),
  API_SESSION_TTL_SECONDS: int(1),

  API_RATE_LIMIT_WINDOW_SECONDS: int(1),
  /** Pencere başına okuma isteği (IP ya da kimlik başına). */
  API_RATE_LIMIT_READ: int(1),
  /** Pencere başına yazma isteği (oturum, tx, teslimat, kart, meta, ispat). */
  API_RATE_LIMIT_WRITE: int(1),

  API_DELIVERY_S3_ENDPOINT: httpUrl,
  API_DELIVERY_S3_REGION: nonEmpty,
  API_DELIVERY_S3_BUCKET: nonEmpty,
  API_DELIVERY_S3_ACCESS_KEY_ID: nonEmpty,
  API_DELIVERY_S3_SECRET_ACCESS_KEY: nonEmpty,
  /** Yol biçimli adresleme (`<endpoint>/<bucket>/<anahtar>`; MinIO ve çoğu S3 uyumlu depo). */
  API_DELIVERY_S3_FORCE_PATH_STYLE: bool,
  /** Nesnelerin herkese açık taban adresi; `deliveryUri` = `<taban>/<workHash>`. */
  API_DELIVERY_PUBLIC_BASE_URL: baseUrl(httpUrl),
  API_DELIVERY_MAX_BYTES: int(1),

  /** Dispute kanıtlarının kovası (teslimat deposuyla aynı uç ve kimlik); herkese açık okunmaz. */
  API_EVIDENCE_S3_BUCKET: nonEmpty,
  API_EVIDENCE_MAX_BYTES: int(1),
  /** Escrow config'inden okunan arbitrator setinin önbellek süresi. */
  API_ARBITRATOR_CACHE_SECONDS: int(0),

  /** Webhook sırlarının anahtar halkası (`kimlik:base64,…`, her anahtar 32 bayt) ve etkin anahtar. */
  API_SECRET_BOX_KEYS: nonEmpty,
  API_SECRET_BOX_ACTIVE_KEY: nonEmpty,
  /** Arbitrator bildirim outbox'ının tur aralığı ve tur başına teslimat. */
  API_NOTIFY_INTERVAL_MS: int(1),
  API_NOTIFY_BATCH_SIZE: int(1, 1_000),
  API_NOTIFY_TIMEOUT_MS: int(1),
  API_NOTIFY_MAX_ATTEMPTS: int(1, 100),
  API_NOTIFY_BACKOFF_BASE_SECONDS: int(1),
  API_NOTIFY_BACKOFF_MAX_SECONDS: int(1),
  /** Son tarihe bu kadar saniye kala oy vermemiş arbitrator'lara `dispute.deadline` gönderilir. */
  API_NOTIFY_DEADLINE_WARNING_SECONDS: int(1),
  /** Yalnızca geliştirme: webhook ucu http ya da özel ağ adresi olabilir. */
  API_NOTIFY_ALLOW_INSECURE: bool,

  /** Square address lookup table'ı; verilirse hazırlanan her tx'e eklenir (BC-28). */
  API_LOOKUP_TABLE: optional(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'base58 adres bekleniyor')),
  /** `computeUnitPrice` verilmeyen tx'lerin priority fee'si (mikro-lamport / CU). */
  API_COMPUTE_UNIT_PRICE: nonEmpty.regex(/^(0|[1-9][0-9]{0,19})$/, 'u64 ondalık bekleniyor').transform(BigInt),

  API_PROVER_URL: baseUrl(httpUrl),
  /** API'nin prover'a gönderdiği servis anahtarı. */
  API_PROVER_API_KEY: nonEmpty,
  API_PROVER_TIMEOUT_MS: int(1),

  /**
   * Travel Rule kayıtlarının ana anahtar halkası (virgülle `kimlik:base64`). Döndürmede yeni anahtar eklenir ve
   * etkin yapılır; eskisi, bakım bütün veri anahtarlarını yeniden sarana kadar halkada kalır (ADR 0017).
   */
  API_TRAVEL_RULE_KEYS: commaList(TRAVEL_RULE_KEY),
  /** Yeni kayıtların ve yeniden sarmanın kullandığı anahtar. */
  API_TRAVEL_RULE_ACTIVE_KEY_ID: TRAVEL_RULE_KEY_ID,
  /** Kaydın son yazmadan sonra saklandığı gün sayısı; hukuki karar, kurulumda verilir. */
  API_TRAVEL_RULE_RETENTION_DAYS: int(1),
  /** Saklama süresi dolan kayıtların silinmesi ve anahtarların yeniden sarılması aralığı. */
  API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS: int(1),

  /** `api_errors` alarmı: iç hata sayısı bu değerin üstüne ... */
  API_ALERT_ERRORS: int(0),
  /** ... bu kadar saniyelik pencerede çıkarsa çalar. */
  API_ALERT_ERROR_WINDOW_SECONDS: int(1),
});

export interface DeliveryStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly publicBaseUrl: string;
}

export interface NotifyConfig {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoff: { readonly baseSeconds: number; readonly maxSeconds: number };
  readonly deadlineWarningSeconds: number;
  readonly allowInsecure: boolean;
}

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly port: number;
  readonly metricsPort: number;
  readonly publicBaseUrl: string;
  readonly corsOrigins: readonly string[];
  readonly trustProxyHops: number;
  readonly jsonMaxBytes: number;
  readonly rpc: { readonly urls: readonly string[]; readonly timeoutMs: number; readonly cooldownMs: number };
  readonly auth: { readonly domain: string; readonly challengeTtlSeconds: number; readonly sessionTtlSeconds: number };
  readonly rateLimit: { readonly windowSeconds: number; readonly read: number; readonly write: number };
  readonly deliveries: { readonly store: DeliveryStoreConfig; readonly maxBytes: number };
  readonly evidence: { readonly bucket: string; readonly maxBytes: number };
  readonly arbitratorCacheSeconds: number;
  readonly secretBox: { readonly keys: Readonly<Record<string, Uint8Array>>; readonly activeKeyId: string };
  readonly notify: NotifyConfig;
  readonly tx: { readonly lookupTable: string | null; readonly computeUnitPrice: bigint };
  readonly prover: { readonly url: string; readonly apiKey: string; readonly timeoutMs: number };
  readonly travelRule: {
    readonly keys: ReadonlyMap<string, Buffer>;
    readonly activeKeyId: string;
    readonly retentionSeconds: number;
    readonly maintenanceIntervalSeconds: number;
  };
  readonly alerts: { readonly errors: number; readonly errorWindowSeconds: number };
  readonly observability: ObservabilityConfig;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ApiConfig {
  const parsed = EnvSchema.safeParse(env);
  const observability = parseObservabilityEnv(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...(observability.ok ? [] : observability.problems),
  ];
  let secretKeys: Record<string, Uint8Array> | null = null;
  if (parsed.success) {
    const e = parsed.data;
    if (e.API_PORT === e.API_METRICS_PORT) problems.push('API_METRICS_PORT: API_PORT ile aynı olamaz');
    if (e.API_PUBLIC_BASE_URL.length + CARD_PATH_MAX > AGENT_CARD_URI_MAX) {
      problems.push(`API_PUBLIC_BASE_URL: agent card URI'si ${AGENT_CARD_URI_MAX} karakteri aşar`);
    }
    if (e.API_DELIVERY_PUBLIC_BASE_URL.length + 1 + 64 > DELIVERY_URI_MAX) {
      problems.push(`API_DELIVERY_PUBLIC_BASE_URL: deliveryUri ${DELIVERY_URI_MAX} karakteri aşar`);
    }
    if (e.API_EVIDENCE_S3_BUCKET === e.API_DELIVERY_S3_BUCKET) {
      problems.push('API_EVIDENCE_S3_BUCKET: teslimat kovası herkese açık okunur; kanıt kovası ondan ayrı olmalı');
    }
    if (e.API_NOTIFY_BACKOFF_MAX_SECONDS < e.API_NOTIFY_BACKOFF_BASE_SECONDS) {
      problems.push('API_NOTIFY_BACKOFF_MAX_SECONDS: API_NOTIFY_BACKOFF_BASE_SECONDS’tan küçük olamaz');
    }
    try {
      const keys = parseSecretBoxKeys(e.API_SECRET_BOX_KEYS);
      if (!Object.hasOwn(keys, e.API_SECRET_BOX_ACTIVE_KEY)) {
        problems.push('API_SECRET_BOX_ACTIVE_KEY: anahtar halkasında yok');
      }
      secretKeys = keys;
    } catch (error) {
      // Anahtarın kendisi hata mesajına yazılmaz; ayrıştırıcının mesajı yalnızca kimlik ve biçim içerir.
      problems.push(`API_SECRET_BOX_KEYS: ${(error as Error).message}`);
    }
    const ids = e.API_TRAVEL_RULE_KEYS.map((entry) => entry.split(':')[0]!);
    if (new Set(ids).size !== ids.length) problems.push('API_TRAVEL_RULE_KEYS: aynı kimlik iki kez verilmiş');
    if (!ids.includes(e.API_TRAVEL_RULE_ACTIVE_KEY_ID)) {
      problems.push('API_TRAVEL_RULE_ACTIVE_KEY_ID: API_TRAVEL_RULE_KEYS içinde yok');
    }
  }
  if (!parsed.success || !observability.ok || problems.length > 0 || !secretKeys) {
    throw new Error(`Geçersiz API ortamı:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
  }
  const e = parsed.data;
  return Object.freeze({
    databaseUrl: e.DATABASE_URL,
    port: e.API_PORT,
    metricsPort: e.API_METRICS_PORT,
    publicBaseUrl: e.API_PUBLIC_BASE_URL,
    corsOrigins: Object.freeze([...e.CORS_ORIGINS]),
    trustProxyHops: e.API_TRUST_PROXY_HOPS,
    jsonMaxBytes: e.API_JSON_MAX_BYTES,
    rpc: Object.freeze({
      urls: Object.freeze([...e.API_RPC_URLS]),
      timeoutMs: e.API_RPC_TIMEOUT_MS,
      cooldownMs: e.API_RPC_COOLDOWN_MS,
    }),
    auth: Object.freeze({
      domain: e.API_AUTH_DOMAIN,
      challengeTtlSeconds: e.API_AUTH_CHALLENGE_TTL_SECONDS,
      sessionTtlSeconds: e.API_SESSION_TTL_SECONDS,
    }),
    rateLimit: Object.freeze({
      windowSeconds: e.API_RATE_LIMIT_WINDOW_SECONDS,
      read: e.API_RATE_LIMIT_READ,
      write: e.API_RATE_LIMIT_WRITE,
    }),
    deliveries: Object.freeze({
      store: Object.freeze({
        endpoint: e.API_DELIVERY_S3_ENDPOINT,
        region: e.API_DELIVERY_S3_REGION,
        bucket: e.API_DELIVERY_S3_BUCKET,
        accessKeyId: e.API_DELIVERY_S3_ACCESS_KEY_ID,
        secretAccessKey: e.API_DELIVERY_S3_SECRET_ACCESS_KEY,
        forcePathStyle: e.API_DELIVERY_S3_FORCE_PATH_STYLE,
        publicBaseUrl: e.API_DELIVERY_PUBLIC_BASE_URL,
      }),
      maxBytes: e.API_DELIVERY_MAX_BYTES,
    }),
    evidence: Object.freeze({ bucket: e.API_EVIDENCE_S3_BUCKET, maxBytes: e.API_EVIDENCE_MAX_BYTES }),
    arbitratorCacheSeconds: e.API_ARBITRATOR_CACHE_SECONDS,
    secretBox: Object.freeze({ keys: Object.freeze(secretKeys), activeKeyId: e.API_SECRET_BOX_ACTIVE_KEY }),
    notify: Object.freeze({
      intervalMs: e.API_NOTIFY_INTERVAL_MS,
      batchSize: e.API_NOTIFY_BATCH_SIZE,
      timeoutMs: e.API_NOTIFY_TIMEOUT_MS,
      maxAttempts: e.API_NOTIFY_MAX_ATTEMPTS,
      backoff: Object.freeze({
        baseSeconds: e.API_NOTIFY_BACKOFF_BASE_SECONDS,
        maxSeconds: e.API_NOTIFY_BACKOFF_MAX_SECONDS,
      }),
      deadlineWarningSeconds: e.API_NOTIFY_DEADLINE_WARNING_SECONDS,
      allowInsecure: e.API_NOTIFY_ALLOW_INSECURE,
    }),
    tx: Object.freeze({ lookupTable: e.API_LOOKUP_TABLE ?? null, computeUnitPrice: e.API_COMPUTE_UNIT_PRICE }),
    prover: Object.freeze({ url: e.API_PROVER_URL, apiKey: e.API_PROVER_API_KEY, timeoutMs: e.API_PROVER_TIMEOUT_MS }),
    travelRule: Object.freeze({
      keys: new Map(
        e.API_TRAVEL_RULE_KEYS.map((entry) => {
          const [id, key] = entry.split(':') as [string, string];
          return [id, Buffer.from(key, 'base64')] as const;
        }),
      ),
      activeKeyId: e.API_TRAVEL_RULE_ACTIVE_KEY_ID,
      retentionSeconds: e.API_TRAVEL_RULE_RETENTION_DAYS * SECONDS_PER_DAY,
      maintenanceIntervalSeconds: e.API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS,
    }),
    alerts: Object.freeze({ errors: e.API_ALERT_ERRORS, errorWindowSeconds: e.API_ALERT_ERROR_WINDOW_SECONDS }),
    observability: observability.config,
  });
}
