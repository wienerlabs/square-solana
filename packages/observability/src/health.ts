// `GET /health` (canlılık) ve `GET /ready` (hazırlık), API sözleşmesindeki `Health` şemasıyla. Canlılık
// süreç ayakta mı sorusunu yanıtlar ve bağımlılıklara bakmaz; hazırlık her denetimi süre sınırıyla koşar,
// biri bile başarısızsa 503 döner. Başarısızlığın sebebi yanıtta değil log'dadır.
import type { Health } from '@squaresdk/solana-types';
import type { Logger } from './logger.js';

/** Hazırlık denetimi: başarısızlıkta hata fırlatır ya da `false` döner. */
export type HealthCheck = () => Promise<boolean | void> | boolean | void;

export interface HealthResult {
  readonly httpStatus: 200 | 503;
  readonly body: Health;
}

export interface HealthOptions {
  version: string;
  checks: Readonly<Record<string, HealthCheck>>;
  /** Tek bir denetimin en uzun süresi; aşılırsa denetim başarısız sayılır. */
  timeoutMs: number;
  logger: Logger;
}

export interface HealthProbe {
  live(): HealthResult;
  ready(): Promise<HealthResult>;
}

class CheckTimeout extends Error {
  constructor(ms: number) {
    super(`denetim ${ms} ms içinde bitmedi`);
    this.name = 'CheckTimeout';
  }
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout(timeoutMs)), timeoutMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(check), timeout]);
    if (result === false) throw new Error('denetim başarısız');
  } finally {
    clearTimeout(timer);
  }
}

export function createHealth(options: HealthOptions): HealthProbe {
  if (!(options.timeoutMs > 0)) throw new Error('timeoutMs pozitif olmalı');
  const names = Object.keys(options.checks);
  return {
    live: () => ({ httpStatus: 200, body: { status: 'ok', version: options.version, checks: {} } }),
    async ready() {
      const results = await Promise.all(
        names.map(async (name) => {
          try {
            await runCheck(options.checks[name]!, options.timeoutMs);
            return [name, 'ok'] as const;
          } catch (error) {
            options.logger.warn('health_check_failed', { check: name, error });
            return [name, 'fail'] as const;
          }
        }),
      );
      const failed = results.filter(([, state]) => state === 'fail').length;
      const status = failed === 0 ? 'ok' : failed === names.length ? 'down' : 'degraded';
      return {
        httpStatus: failed === 0 ? 200 : 503,
        body: { status, version: options.version, checks: Object.fromEntries(results) },
      };
    },
  };
}

export interface HealthResponseLike {
  status(code: number): HealthResponseLike;
  set(field: string, value: string): HealthResponseLike;
  json(body: unknown): unknown;
}

/** Sonucu önbelleğe alınmayacak biçimde yazar (Express uyumlu). */
export function sendHealth(res: HealthResponseLike, result: HealthResult): void {
  res.status(result.httpStatus).set('cache-control', 'no-store').json(result.body);
}
