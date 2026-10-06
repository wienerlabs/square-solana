// Kalıcı durumun arayüzleri. Postgres uygulaması `@squaresdk/solana-hardening/prisma`'dadır
// (`rate_limit_windows`, `idempotency_records`, `replay_guards`; db/prisma/schema.prisma). Birden çok
// servis örneği aynı veritabanını paylaştığı için sınırlar ve tekrar korumaları örnekler arası geçerlidir.

/** Tek kullanımlık kimlikler (webhook teslimat kimliği, imzalı eylem nonce'u). */
export interface ReplayStore {
  /**
   * Kimliği `expiresAt`'e kadar kullanılmış işaretler. Kimlik süresi dolmadan önce kullanılmışsa `false`
   * döner (tekrar oynatma); işlem atomiktir, eşzamanlı iki istekten yalnızca biri `true` alır.
   */
  claim(scope: string, id: string, expiresAt: Date, now: Date): Promise<boolean>;
}

/** Sabit pencere sayacı. */
export interface RateLimitStore {
  /** Anahtarın `windowStart` penceresindeki sayacını `cost` artırır ve yeni değeri döner (atomik). */
  hit(key: string, windowStart: Date, cost: number, expiresAt: Date): Promise<number>;
}

export type IdempotencyBegin =
  | { readonly state: 'started' }
  | { readonly state: 'in_progress' }
  | { readonly state: 'mismatch' }
  | { readonly state: 'completed'; readonly status: number; readonly body: unknown };

export interface IdempotencyStore {
  /**
   * Anahtarı bu istek için ayırır. Yeni ya da süresi dolmuş anahtarda `started`; aynı istek sürüyorsa
   * `in_progress`; tamamlanmışsa kaydedilen yanıt; anahtar başka bir istekle kullanılmışsa `mismatch`.
   */
  begin(scope: string, key: string, requestHash: string, expiresAt: Date, now: Date): Promise<IdempotencyBegin>;
  /** Yanıtı kaydeder; sonraki tekrarlar bunu alır. */
  complete(scope: string, key: string, status: number, body: unknown): Promise<void>;
  /** İşlem yanıt üretmeden düştüyse ayrılan anahtarı bırakır; istemci yeniden deneyebilir. */
  abandon(scope: string, key: string): Promise<void>;
}

/** Süresi dolan satırları siler; silinen satır sayısını döner. */
export interface ExpiringStore {
  purgeExpired(now: Date): Promise<number>;
}
