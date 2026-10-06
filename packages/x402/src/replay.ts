// Ödeme yükünün kalıcı tekrar koruması. Aynı ödeme yükü (aynı imzalı Solana işlemi) ikinci kez kabul
// edilmez; kayıt veritabanında tutulduğu için süreç yeniden başlasa ya da servisin birden çok örneği
// çalışsa da geçerlidir. Depo arayüzü `@squaresdk/solana-hardening`'in `ReplayStore`'uyla yapısal olarak
// aynıdır: servis `createPrismaReplayStore(client)` (`replay_guards` tablosu) verir. Paket bu yüzden
// hardening'e çalışma anında bağlı değildir.
import { createHash } from 'node:crypto';
import type { PaymentPayload } from '@x402/core/types';
import { decodeTransactionFromPayload, transactionMessageHash } from '@x402/svm';

export interface ReplayStore {
  /**
   * Kimliği `expiresAt`'e kadar kullanılmış işaretler. Kimlik süresi dolmadan önce kullanılmışsa `false`
   * döner; işlem atomiktir, eşzamanlı iki istekten yalnızca biri `true` alır.
   */
  claim(scope: string, id: string, expiresAt: Date, now: Date): Promise<boolean>;
}

/** Bellek deposunda süresi dolan kayıtlar bu kadar `claim`'de bir silinir. */
const MEMORY_SWEEP_EVERY = 1_000;

/**
 * Süreç içi tekrar deposu: tek örnekle çalışan sunucular ve geliştirme içindir. Kayıt süreç yeniden başlayınca
 * kaybolur ve örnekler arasında paylaşılmaz; birden çok örnekte ya da kalıcı koruma gerektiğinde veritabanı
 * deposu verilir (Square servislerinde `createPrismaReplayStore`). Süresi dolan kayıtlar ara ara silinir.
 */
export function createMemoryReplayStore(): ReplayStore {
  const seen = new Map<string, number>();
  let claims = 0;
  return {
    async claim(scope, id, expiresAt, now) {
      claims += 1;
      if (claims % MEMORY_SWEEP_EVERY === 0) {
        for (const [key, until] of seen) if (until <= now.getTime()) seen.delete(key);
      }
      const key = `${scope}\u0000${id}`;
      const until = seen.get(key);
      if (until !== undefined && until > now.getTime()) return false;
      seen.set(key, expiresAt.getTime());
      return true;
    },
  };
}

/** Tekrar korumasının kapsamı: `x402:<CAIP-2 ağı>`. */
export function replayScope(network: string): string {
  return `x402:${network}`;
}

/**
 * Ödeme yükünün kimliği.
 *
 * - Solana işlemi taşıyan yükte (exact şeması) işlem mesajının SHA-256'sı (`svm:` önekli). Resmi
 *   facilitator'ın yinelenen ödeme önbelleğiyle aynı anahtardır: mesaj her imzacının imzaladığı veridir;
 *   ücret ödeyenin imza yuvası facilitator tarafından yeniden yazıldığı için tel baytları kimlik olamaz.
 * - Diğer yüklerde şema, ağ ve yükün kanonik JSON'unun SHA-256'sı (`json:` önekli).
 */
export function paymentFingerprint(payload: Pick<PaymentPayload, 'accepted' | 'payload'>): string {
  const transaction = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof transaction === 'string') {
    try {
      const hash = transactionMessageHash(decodeTransactionFromPayload({ transaction }));
      return `svm:${Buffer.from(hash, 'base64').toString('hex')}`;
    } catch {
      // Çözülemeyen işlem facilitator doğrulamasından geçmez; kimlik yine de kararlı olmalı.
    }
  }
  const canonical = canonicalJson({
    scheme: payload.accepted.scheme,
    network: payload.accepted.network,
    payload: payload.payload,
  });
  return `json:${createHash('sha256').update(canonical).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
