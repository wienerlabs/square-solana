// Travel Rule kaydının zarf şifrelemesi (ADR 0017). Her kayıt kendi 32 baytlık rastgele veri anahtarıyla
// AES-256-GCM ile şifrelenir; veri anahtarı ana anahtar halkasının etkin anahtarıyla, yine AES-256-GCM ile
// sarılır. Ek doğrulanan veri (AAD) şifreli kaydı job'a ve commitment'a, sarılmış anahtarı job'a ve anahtar
// kimliğine bağlar: başka bir satıra kopyalanan şifreli veri açılmaz. Ana anahtarlar ortamdandır
// (`TRAVEL_RULE_KEYS`). Döndürmede yeni anahtar etkin yapılır, eski kayıtların veri anahtarları bakımda yeniden
// sarılır (`rewrap`); kaydın kendisi yeniden şifrelenmez.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface Keyring {
  readonly activeKeyId: string;
  /** Kimliği verilen ana anahtar; halkada yoksa hata. */
  key(id: string): Buffer;
}

export function createKeyring(keys: ReadonlyMap<string, Buffer>, activeKeyId: string): Keyring {
  for (const [id, key] of keys) {
    if (key.length !== KEY_BYTES) throw new Error(`ana anahtar ${id} ${KEY_BYTES} bayt olmalı`);
  }
  if (!keys.has(activeKeyId)) throw new Error(`etkin anahtar ${activeKeyId} halkada yok`);
  return {
    activeKeyId,
    key(id) {
      const key = keys.get(id);
      if (!key) throw new Error(`ana anahtar ${id} halkada yok`);
      return key;
    },
  };
}

/** Şifreli kayıt; `ciphertext` GCM etiketini sonunda taşır, `wrappedKey` IV ‖ şifreli anahtar ‖ etiket'tir. */
export interface Sealed {
  readonly algorithm: typeof ALGORITHM;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly keyId: string;
  readonly wrappedKey: Buffer;
}

/** Şifreli verinin bağlandığı satır. */
export interface SealContext {
  readonly job: string;
  readonly commitment: string;
}

const recordAad = ({ job, commitment }: SealContext) =>
  Buffer.from(`square/travel-rule/record/v1|${job}|${commitment}`);
const keyAad = (job: string, keyId: string) => Buffer.from(`square/travel-rule/key/v1|${job}|${keyId}`);

function encrypt(key: Buffer, iv: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key: Buffer, iv: Buffer, data: Buffer, aad: Buffer): Buffer {
  if (data.length < TAG_BYTES) throw new Error('şifreli veri kısa');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]);
}

function wrap(keyring: Keyring, dataKey: Buffer, job: string): { keyId: string; wrappedKey: Buffer } {
  const keyId = keyring.activeKeyId;
  const iv = randomBytes(IV_BYTES);
  return { keyId, wrappedKey: Buffer.concat([iv, encrypt(keyring.key(keyId), iv, dataKey, keyAad(job, keyId))]) };
}

function unwrap(keyring: Keyring, sealed: Pick<Sealed, 'keyId' | 'wrappedKey'>, job: string): Buffer {
  const iv = sealed.wrappedKey.subarray(0, IV_BYTES);
  return decrypt(keyring.key(sealed.keyId), iv, sealed.wrappedKey.subarray(IV_BYTES), keyAad(job, sealed.keyId));
}

export function seal(keyring: Keyring, plaintext: Buffer, context: SealContext): Sealed {
  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  try {
    const ciphertext = encrypt(dataKey, iv, plaintext, recordAad(context));
    return { algorithm: ALGORITHM, ciphertext, iv, ...wrap(keyring, dataKey, context.job) };
  } finally {
    dataKey.fill(0);
  }
}

export function open(keyring: Keyring, sealed: Sealed, context: SealContext): Buffer {
  if (sealed.algorithm !== ALGORITHM) throw new Error(`desteklenmeyen algoritma: ${sealed.algorithm}`);
  const dataKey = unwrap(keyring, sealed, context.job);
  try {
    return decrypt(dataKey, sealed.iv, sealed.ciphertext, recordAad(context));
  } finally {
    dataKey.fill(0);
  }
}

/** Veri anahtarını etkin ana anahtarla yeniden sarar. */
export function rewrap(
  keyring: Keyring,
  sealed: Pick<Sealed, 'keyId' | 'wrappedKey'>,
  job: string,
): { keyId: string; wrappedKey: Buffer } {
  const dataKey = unwrap(keyring, sealed, job);
  try {
    return wrap(keyring, dataKey, job);
  } finally {
    dataKey.fill(0);
  }
}
