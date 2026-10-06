// İdempotent istekler: istemci yan etkili bir isteği (`Idempotency-Key` başlığıyla) yeniden gönderdiğinde
// işlem ikinci kez yapılmaz, ilk yanıt döner. Anahtar başka bir istekle kullanılamaz (isteğin özeti
// karşılaştırılır); aynı istek sürerken gelen tekrar `in_progress` alır. 5xx yanıtlar ve hatalar
// kaydedilmez, istemci yeniden deneyebilir. Kayıtlar `ttlSeconds` sonra düşer.
import { createHash } from 'node:crypto';
import type { IdempotencyStore } from './stores.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Anahtar biçimi: 8–128 karakter, harf, rakam, `-` ve `_` (UUID uyar). */
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

export type IdempotencyFailure = 'invalid_key' | 'in_progress' | 'mismatch';

export class IdempotencyError extends Error {
  constructor(
    readonly reason: IdempotencyFailure,
    message: string,
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

export interface IdempotentResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Anahtar sırasından bağımsız JSON (isteğin özeti için). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** İsteğin özeti: yöntem, yol, gövde ve kimliği belirleyen alanlar. */
export const requestHash = (request: unknown): string => createHash('sha256').update(stableJson(request)).digest('hex');

export interface Idempotency {
  run(params: {
    /** Anahtar alanı (ör. `api:<cüzdan>`): farklı istemcilerin anahtarları çakışmaz. */
    scope: string;
    key: string;
    request: unknown;
    handler: () => Promise<IdempotentResponse>;
  }): Promise<IdempotentResponse & { readonly replayed: boolean }>;
}

export function createIdempotency(params: {
  store: IdempotencyStore;
  ttlSeconds: number;
  clock?: () => number;
}): Idempotency {
  if (!Number.isInteger(params.ttlSeconds) || params.ttlSeconds < 1) throw new Error('ttlSeconds pozitif olmalı');
  const clock = params.clock ?? Date.now;
  return {
    async run({ scope, key, request, handler }) {
      if (!KEY.test(key))
        throw new IdempotencyError('invalid_key', 'Idempotency-Key 8–128 karakter [A-Za-z0-9_-] olmalı');
      const now = clock();
      const hash = requestHash(request);
      const begun = await params.store.begin(scope, key, hash, new Date(now + params.ttlSeconds * 1000), new Date(now));
      switch (begun.state) {
        case 'in_progress':
          throw new IdempotencyError('in_progress', 'aynı anahtarlı istek hâlâ işleniyor');
        case 'mismatch':
          throw new IdempotencyError('mismatch', 'bu anahtar başka bir istekle kullanıldı');
        case 'completed':
          return { status: begun.status, body: begun.body, replayed: true };
        case 'started':
          break;
      }
      let response: IdempotentResponse;
      try {
        response = await handler();
      } catch (error) {
        await params.store.abandon(scope, key);
        throw error;
      }
      if (response.status >= 500) await params.store.abandon(scope, key);
      else await params.store.complete(scope, key, response.status, response.body);
      return { ...response, replayed: false };
    },
  };
}
