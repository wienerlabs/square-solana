// Servislerin ortak gözlemlenebilirlik ortamı: log düzeyi, hazırlık denetimlerinin süre sınırı, alarm
// değerlendirme aralığı ve isteğe bağlı alarm webhook'u. Varsayılan değer yoktur; servis açılışta
// doğrular ve eksik ya da geçersiz değerde açılmaz. Servise özgü alarm eşikleri servisin kendi ortamındadır.
import { z } from 'zod';
import { webhookNotifier, type AlarmNotifier } from './alarms.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

const nonEmpty = z.string().trim().min(1);
const positiveInt = nonEmpty.transform(Number).pipe(z.number().int().min(1));
/** İsteğe bağlı değişkende boş değer (ör. `.env` dosyasındaki `ADI=`) tanımsız sayılır. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(LOG_LEVELS),
  /** Tek bir hazırlık denetiminin süre sınırı (ms). */
  HEALTH_CHECK_TIMEOUT_MS: positiveInt,
  /** Alarm kurallarının değerlendirilme aralığı (saniye). */
  ALERT_EVALUATION_SECONDS: positiveInt,
  /** Verilirse alarm olayları bu adrese JSON olarak gönderilir; verilmezse yalnızca log'a yazılır. */
  ALERT_WEBHOOK_URL: optional(z.url()),
  ALERT_WEBHOOK_TIMEOUT_MS: optional(positiveInt),
});

/** Webhook adresi verilince süresi de gerekir. Diğer alanlar hatalı olsa da raporlansın diye şemanın dışında. */
const webhookProblems = (env: Readonly<Record<string, string | undefined>>): string[] =>
  env['ALERT_WEBHOOK_URL']?.trim() && !env['ALERT_WEBHOOK_TIMEOUT_MS']?.trim()
    ? ['ALERT_WEBHOOK_TIMEOUT_MS: ALERT_WEBHOOK_URL verilince gerekli']
    : [];

export interface ObservabilityConfig {
  readonly logLevel: LogLevel;
  readonly healthCheckTimeoutMs: number;
  readonly alertEvaluationSeconds: number;
  readonly webhook: { readonly url: string; readonly timeoutMs: number } | null;
}

export type ObservabilityEnvResult =
  | { readonly ok: true; readonly config: ObservabilityConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Ortamdaki gözlemlenebilirlik değişkenlerini doğrular; sorunlar `DEĞİŞKEN: mesaj` biçimindedir. */
export function parseObservabilityEnv(env: Readonly<Record<string, string | undefined>>): ObservabilityEnvResult {
  const parsed = EnvSchema.safeParse(env);
  const problems = [
    ...(parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)),
    ...webhookProblems(env),
  ];
  if (!parsed.success || problems.length > 0) return { ok: false, problems };
  const e = parsed.data;
  return {
    ok: true,
    config: Object.freeze({
      logLevel: e.LOG_LEVEL,
      healthCheckTimeoutMs: e.HEALTH_CHECK_TIMEOUT_MS,
      alertEvaluationSeconds: e.ALERT_EVALUATION_SECONDS,
      webhook:
        e.ALERT_WEBHOOK_URL && e.ALERT_WEBHOOK_TIMEOUT_MS
          ? Object.freeze({ url: e.ALERT_WEBHOOK_URL, timeoutMs: e.ALERT_WEBHOOK_TIMEOUT_MS })
          : null,
    }),
  };
}

/** Yapılandırmadaki bildirim kanalları: webhook verilmişse o; alarm olayları her durumda log'a da yazılır. */
export const alarmNotifiers = (config: ObservabilityConfig): AlarmNotifier[] =>
  config.webhook ? [webhookNotifier(config.webhook)] : [];
