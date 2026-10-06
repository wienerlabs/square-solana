// Gizli değerlerin (üçüncü taraf API anahtarları, webhook sırları …) veritabanında şifreli tutulması:
// AES-256-GCM, anahtar halkasıyla. Biçim: `sq1.<anahtar kimliği>.<iv>.<şifreli metin + etiket>` (base64url).
// Anahtar kimliği şifreli değerde durduğu için anahtar döndürülürken eskiler halkada kalır, yeni değerler
// etkin anahtarla şifrelenir. AAD (ek doğrulanmış veri) değeri bir bağlama (ör. kaydın kimliği) bağlar:
// başka bir kayda kopyalanan şifreli değer açılmaz. Anahtarlar 32 rastgele bayttır; paroladan türetilmez.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'sq1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export interface SecretBox {
  readonly activeKeyId: string;
  seal(plaintext: string | Uint8Array, aad?: string): string;
  open(sealed: string, aad?: string): Uint8Array;
  openText(sealed: string, aad?: string): string;
  /** Değer etkin anahtardan başka bir anahtarla mı şifrelenmiş (yeniden şifrelenmeli). */
  needsRotation(sealed: string): boolean;
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

function parse(sealed: string) {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('şifreli değerin biçimi tanınmıyor');
  const [, keyId, iv, body] = parts as [string, string, string, string];
  const ivBytes = Buffer.from(iv, 'base64url');
  const bodyBytes = Buffer.from(body, 'base64url');
  if (ivBytes.length !== IV_BYTES || bodyBytes.length < TAG_BYTES) {
    throw new SecretBoxError('şifreli değerin biçimi tanınmıyor');
  }
  return { keyId, iv: ivBytes, ciphertext: bodyBytes.subarray(0, -TAG_BYTES), tag: bodyBytes.subarray(-TAG_BYTES) };
}

export function createSecretBox(params: {
  keys: Readonly<Record<string, Uint8Array>>;
  activeKeyId: string;
}): SecretBox {
  const keys = new Map(Object.entries(params.keys));
  for (const [id, key] of keys) {
    if (!KEY_ID.test(id)) throw new SecretBoxError(`anahtar kimliği geçersiz: ${id}`);
    if (key.length !== KEY_BYTES) throw new SecretBoxError(`${id}: anahtar ${KEY_BYTES} bayt olmalı`);
  }
  const active = keys.get(params.activeKeyId);
  if (!active) throw new SecretBoxError(`etkin anahtar halkada yok: ${params.activeKeyId}`);

  const open = (sealed: string, aad?: string): Uint8Array => {
    const { keyId, iv, ciphertext, tag } = parse(sealed);
    const key = keys.get(keyId);
    if (!key) throw new SecretBoxError(`anahtar halkada yok: ${keyId}`);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new SecretBoxError('şifreli değer doğrulanamadı (yanlış anahtar, bağlam ya da bozuk değer)');
    }
  };

  return {
    activeKeyId: params.activeKeyId,
    seal(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, active, iv);
      if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
      const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
      return [VERSION, params.activeKeyId, iv.toString('base64url'), body.toString('base64url')].join('.');
    },
    open,
    openText: (sealed, aad) => Buffer.from(open(sealed, aad)).toString('utf8'),
    needsRotation: (sealed) => parse(sealed).keyId !== params.activeKeyId,
  };
}

/**
 * Ortamdaki anahtar halkası: `kimlik:base64,kimlik:base64` (her anahtar 32 bayt). Anahtar üretmek için:
 * `openssl rand -base64 32`.
 */
export function parseSecretBoxKeys(value: string): Record<string, Uint8Array> {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(':');
      if (separator <= 0) throw new SecretBoxError('anahtar "kimlik:base64" biçiminde olmalı');
      const id = part.slice(0, separator);
      const key = Buffer.from(part.slice(separator + 1), 'base64');
      if (key.length !== KEY_BYTES) throw new SecretBoxError(`${id}: anahtar ${KEY_BYTES} bayt olmalı`);
      return [id, new Uint8Array(key)] as const;
    });
  if (entries.length === 0) throw new SecretBoxError('en az bir anahtar gerekli');
  if (new Set(entries.map(([id]) => id)).size !== entries.length)
    throw new SecretBoxError('anahtar kimliği tekrar ediyor');
  return Object.fromEntries(entries);
}
