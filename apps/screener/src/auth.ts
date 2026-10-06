// `x-api-key` denetimi (prover'ınkiyle aynı yöntem): ortamda anahtarların yalnızca SHA-256'sı durur; gelen
// anahtarın özeti her kayıtlı özetle sabit sürede karşılaştırılır. Geçerli anahtarın parmak izi özetin ilk
// 16 hex karakteridir: denetim kaydına (`caller`) ve hız sınırı anahtarına girer, anahtarın kendisi girmez.
import { createHash } from 'node:crypto';
import { safeEqual } from '@squaresdk/solana-hardening';

const FINGERPRINT_LENGTH = 16;

/** Geçerli anahtarda parmak izi, geçersizde null. */
export type ApiKeyCheck = (key: string | undefined) => string | null;

export function apiKeyCheck(sha256Hex: readonly string[]): ApiKeyCheck {
  return (key) => {
    if (!key) return null;
    const digest = createHash('sha256').update(key, 'utf8').digest('hex');
    const match = sha256Hex.reduce((found, candidate) => safeEqual(candidate, digest) || found, false);
    return match ? digest.slice(0, FINGERPRINT_LENGTH) : null;
  };
}
