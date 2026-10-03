// `x-api-key` denetimi. Ortamda anahtarların yalnızca SHA-256'sı durur; gelen anahtarın özeti her
// kayıtlı özetle sabit sürede karşılaştırılır.
import { createHash, timingSafeEqual } from 'node:crypto';

export type ApiKeyCheck = (key: string | undefined) => boolean;

export function apiKeyCheck(sha256Hex: readonly string[]): ApiKeyCheck {
  const allowed = sha256Hex.map((hex) => Buffer.from(hex, 'hex'));
  return (key) => {
    if (!key) return false;
    const digest = createHash('sha256').update(key, 'utf8').digest();
    return allowed.reduce((ok, candidate) => timingSafeEqual(candidate, digest) || ok, false);
  };
}
