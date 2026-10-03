// İstek kimliği ve yetki (docs/design/a2a.md §6): görevler kimliği doğrulanmış çağırana kapsamlıdır ve
// çağıran yalnızca adına yetkili olduğu kurumun job'u için görev açabilir. Hazır uygulama API
// anahtarıdır: istemci `x-api-key` gönderir, sunucu anahtarın SHA-256'sını izinli listeyle sabit zamanda
// karşılaştırır; anahtarın kendisi sunucuda tutulmaz. Cüzdan imzalı istekler BE-13'te.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PublicKey } from '@solana/web3.js';

export interface Caller {
  /** Görevlerin kapsamlandığı kalıcı kimlik. */
  readonly id: string;
  /** Çağıranın adına görev açabildiği kurumlar: `Job.institution` (Squads'a bağlı kurumda vault PDA'sı). */
  readonly institutions: ReadonlySet<string>;
}

/** İsteğin çağıranı; kimlik doğrulanamazsa null. Yalnızca başlıkları okur, gövdeye dokunmaz. */
export type Authenticator = (request: IncomingMessage) => Promise<Caller | null> | Caller | null;

export interface ApiKeyGrant {
  /** Anahtarın SHA-256'sı, 64 küçük harf hex. */
  keySha256: string;
  /** Anahtarın adına görev açabileceği kurum adresleri (base58). */
  institutions: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_KEY_LENGTH = 512;

function institutionSet(addresses: readonly string[]): ReadonlySet<string> {
  if (addresses.length === 0) throw new Error('createApiKeyAuthenticator: her anahtarın en az bir kurumu olmalı');
  return new Set(
    addresses.map((address) => {
      try {
        return new PublicKey(address).toBase58();
      } catch {
        throw new Error(`createApiKeyAuthenticator: kurum adresi geçersiz: ${address}`);
      }
    }),
  );
}

export function createApiKeyAuthenticator(options: { keys: readonly ApiKeyGrant[] }): Authenticator {
  if (options.keys.length === 0) throw new Error('createApiKeyAuthenticator: en az bir anahtar gerekli');
  const seen = new Set<string>();
  const grants = options.keys.map((grant) => {
    if (!HEX64.test(grant.keySha256)) {
      throw new Error("createApiKeyAuthenticator: anahtar hash'i 64 küçük harf hex olmalı");
    }
    if (seen.has(grant.keySha256)) throw new Error("createApiKeyAuthenticator: aynı anahtar hash'i iki kez verildi");
    seen.add(grant.keySha256);
    const caller: Caller = { id: `api-key:${grant.keySha256}`, institutions: institutionSet(grant.institutions) };
    return { bytes: Buffer.from(grant.keySha256, 'hex'), caller };
  });
  return (request) => {
    const header = request.headers['x-api-key'];
    if (typeof header !== 'string' || header.length === 0 || header.length > MAX_KEY_LENGTH) return null;
    const digest = createHash('sha256').update(header, 'utf8').digest();
    let caller: Caller | null = null;
    for (const grant of grants) {
      if (timingSafeEqual(digest, grant.bytes)) caller = grant.caller;
    }
    return caller;
  };
}
