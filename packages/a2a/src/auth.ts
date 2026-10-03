// İstek kimliği (docs/design/a2a.md §6): görevler kimliği doğrulanmış çağırana kapsamlıdır. Hazır
// uygulama API anahtarıdır: istemci `x-api-key` gönderir, sunucu anahtarın SHA-256'sını izinli listeyle
// sabit zamanda karşılaştırır; anahtarın kendisi sunucuda tutulmaz. Cüzdan imzalı istekler BE-13'te.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** İsteğin çağıranı; kimlik doğrulanamazsa null. */
export type Authenticator = (request: IncomingMessage) => Promise<string | null> | string | null;

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_KEY_LENGTH = 512;

export function createApiKeyAuthenticator(options: { keySha256: readonly string[] }): Authenticator {
  if (options.keySha256.length === 0) throw new Error("createApiKeyAuthenticator: en az bir anahtar hash'i gerekli");
  for (const hash of options.keySha256) {
    if (!HEX64.test(hash)) throw new Error("createApiKeyAuthenticator: anahtar hash'i 64 küçük harf hex olmalı");
  }
  const allowed = options.keySha256.map((hash) => ({ hash, bytes: Buffer.from(hash, 'hex') }));
  return (request) => {
    const header = request.headers['x-api-key'];
    if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) return null;
    const digest = createHash('sha256').update(header, 'utf8').digest();
    let caller: string | null = null;
    for (const candidate of allowed) {
      if (timingSafeEqual(digest, candidate.bytes)) caller = `api-key:${candidate.hash}`;
    }
    return caller;
  };
}
