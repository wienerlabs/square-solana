// Kalıcı hız sınırı: anahtar başına sabit pencere (ör. 60 saniyede 120 istek). Sayaç paylaşılan depoda
// (Postgres) tutulduğu için servisin bütün örneklerinde ve yeniden başlatmadan sonra da geçerlidir.
// Yanıt başlıkları IETF taslağındaki `RateLimit-*` adlarıyla.
import type { RateLimitStore } from './stores.js';

export interface RateLimitRule {
  /** Penceredeki en fazla istek (ağırlık toplamı). */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: Date;
  /** Reddedilen istekte bir sonraki pencereye kadar saniye; izin verilende 0. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
}

export function createRateLimiter(params: {
  store: RateLimitStore;
  rule: RateLimitRule;
  clock?: () => number;
}): RateLimiter {
  const { store, rule } = params;
  if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new Error('limit pozitif tamsayı olmalı');
  if (!Number.isInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
    throw new Error('windowSeconds pozitif tamsayı olmalı');
  }
  const clock = params.clock ?? Date.now;
  const windowMs = rule.windowSeconds * 1000;
  return {
    async consume(key, cost = 1) {
      if (!key) throw new Error('hız sınırı anahtarı boş olamaz');
      if (!Number.isInteger(cost) || cost < 1) throw new Error('cost pozitif tamsayı olmalı');
      const now = clock();
      const start = Math.floor(now / windowMs) * windowMs;
      const resetAt = new Date(start + windowMs);
      const count = await store.hit(key, new Date(start), cost, resetAt);
      const allowed = count <= rule.limit;
      return {
        allowed,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count),
        resetAt,
        retryAfterSeconds: allowed ? 0 : Math.ceil((resetAt.getTime() - now) / 1000),
      };
    },
  };
}

/** Yanıt başlıkları; reddedilen istekte `Retry-After` de. */
export function rateLimitHeaders(decision: RateLimitDecision, now: number = Date.now()): Record<string, string> {
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(decision.limit),
    'RateLimit-Remaining': String(decision.remaining),
    'RateLimit-Reset': String(Math.max(0, Math.ceil((decision.resetAt.getTime() - now) / 1000))),
  };
  return decision.allowed ? headers : { ...headers, 'Retry-After': String(decision.retryAfterSeconds) };
}

export interface RateLimitResponseLike {
  set(field: string, value: string): unknown;
}

/**
 * Express uyumlu ara katman. `keyOf` isteğin öznesini verir (cüzdan, API anahtarı, IP); `null` dönerse
 * sınır uygulanmaz. Reddedilen isteğin yanıtı `reject`'tedir (servisin hata zarfı). Depo hatası isteği
 * düşürür (`next(error)`): sınır denetlenemeden istek geçirilmez.
 */
export function rateLimitMiddleware<Req, Res extends RateLimitResponseLike>(params: {
  limiter: RateLimiter;
  keyOf: (req: Req) => string | null;
  reject: (req: Req, res: Res, decision: RateLimitDecision) => void;
  costOf?: (req: Req) => number;
}): (req: Req, res: Res, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    const key = params.keyOf(req);
    if (key === null) return next();
    params.limiter
      .consume(key, params.costOf?.(req) ?? 1)
      .then((decision) => {
        for (const [name, value] of Object.entries(rateLimitHeaders(decision))) res.set(name, value);
        if (decision.allowed) next();
        else params.reject(req, res, decision);
      })
      .catch(next);
  };
}
