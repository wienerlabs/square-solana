// Kayıt uçlarının erişimi (BE-32): proof kaydı, toplu attestation, imzasız ödeme listesi ve mutabakat yalnızca
// `X-API-Key` ile çağrılır ve anahtar başına hız sınırına tabidir. Ortamda anahtarların yalnızca SHA-256'sı durur
// (`COMPLIANCE_API_KEY_SHA256`); gelen anahtarın özeti her kayıtlı özetle sabit sürede karşılaştırılır. Sayaç
// Square'in tek veritabanındaki `rate_limit_windows` tablosundadır (`@squaresdk/solana-hardening`), servis kopyaları
// arasında paylaşılır. Ücretli rapor x402 ödemesiyle, sağlık uçları açık kalır.
import { createHash, timingSafeEqual } from 'node:crypto';
import { rateLimitHeaders, type RateLimiter } from '@squaresdk/solana-hardening';
import type { RequestHandler, Response } from 'express';
import type { ApiResponse } from '../types/api.js';

export const API_KEY_HEADER = 'x-api-key';

/** Kayıtlı özetlerden biriyle eşleşen anahtarın özeti; eşleşmezse null. */
export type ApiKeyCheck = (key: string | undefined) => string | null;

export function apiKeyCheck(sha256Hex: readonly string[]): ApiKeyCheck {
  const allowed = sha256Hex.map((hex) => Buffer.from(hex, 'hex'));
  return (key) => {
    if (!key) return null;
    const digest = createHash('sha256').update(key, 'utf8').digest();
    // Hepsiyle karşılaştırılır: eşleşmenin sırası süreye yansımaz.
    const matched = allowed.reduce((ok, candidate) => timingSafeEqual(candidate, digest) || ok, false);
    return matched ? digest.toString('hex') : null;
  };
}

function reject(res: Response, status: number, error: string): void {
  const body: ApiResponse<null> = { success: false, data: null, error };
  res.status(status).json(body);
}

/**
 * Anahtar denetimi ve anahtar başına hız sınırı. Sınırlayıcı veritabanı bağlantısıyla birlikte hazırlanır; hazır
 * olmadan gelen istek onu bekler.
 */
export function requireApiKey(deps: { check: ApiKeyCheck; limiter: Promise<RateLimiter> }): RequestHandler {
  return (req, res, next) => {
    const digest = deps.check(req.get(API_KEY_HEADER));
    if (digest === null) {
      reject(res, 401, 'geçerli bir X-API-Key gerekli');
      return;
    }
    deps.limiter
      .then((limiter) => limiter.consume(`compliance:key:${digest.slice(0, 32)}`, 1))
      .then((decision) => {
        for (const [name, value] of Object.entries(rateLimitHeaders(decision))) res.set(name, value);
        if (!decision.allowed) {
          reject(res, 429, 'hız sınırı aşıldı');
          return;
        }
        next();
      }, next);
  };
}
