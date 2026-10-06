// Travel Rule kayıtları ve salt'ları bu tarayıcıda, kurum cüzdanı başına ve şifreli tutulur; kişisel veri
// sunucuya ya da zincire gitmez (FE-18, ADR 0015). Depolama politika sırrının kalıbıdır (policy-local.ts):
// `localStorage`, kurum cüzdanına bağlı anahtar, yalnızca aynı cüzdana geri yüklenen dışa aktarma dosyası.
// Farkı içeriğin şifreli olması: anahtar kurumun parolasından PBKDF2-SHA-256 ile türetilir, içerik AES-256-GCM
// ile şifrelenir (WebCrypto). Parola saklanmaz; türetilen anahtar yalnızca sayfanın belleğindedir ve
// dışarı aktarılamaz (`extractable: false`). Dışa aktarma dosyası depodaki şifreli zarfın kendisidir.
import { z } from 'zod';
import { bytesToHex, hexToBytes } from './policy-draft';
import { TravelRuleEntrySchema, type TravelRuleEntry } from './travel-rule';

export const VAULT_FORMAT = 'square-travel-rule-vault';

/** OWASP'ın PBKDF2-HMAC-SHA-256 için önerdiği tur sayısı (2023). */
export const PBKDF2_ITERATIONS = 600_000;
/** Dosyadan okunan tur sayısının alt sınırı: değiştirilmiş bir dosya türetmeyi zayıflatamaz. */
const MIN_ITERATIONS = 100_000;
export const MIN_PASSPHRASE_LENGTH = 12;

const vaultKeyName = (owner: string) => `square-travel-rule:${owner}`;

const hexOf = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

const KdfSchema = z
  .object({
    name: z.literal('PBKDF2'),
    hash: z.literal('SHA-256'),
    iterations: z.number().int().min(MIN_ITERATIONS).max(10_000_000),
    salt: hexOf(16),
  })
  .strict();
type Kdf = z.infer<typeof KdfSchema>;

const VaultFileSchema = z
  .object({
    format: z.literal(VAULT_FORMAT),
    version: z.literal(1),
    owner: z.string(),
    kdf: KdfSchema,
    cipher: z.object({ name: z.literal('AES-GCM'), iv: hexOf(12) }).strict(),
    ciphertext: z.string().regex(/^(?:[0-9a-f]{2})+$/),
  })
  .strict();
export type VaultFile = z.infer<typeof VaultFileSchema>;

const PlaintextSchema = z.object({ entries: z.array(TravelRuleEntrySchema) }).strict();

/** Parolayla açılmış depo: anahtar bellekte, türetme parametreleri yeniden şifrelemek için. */
export interface VaultKey {
  owner: string;
  kdf: Kdf;
  key: CryptoKey;
}

const encoder = new TextEncoder();

/** WebCrypto `ArrayBuffer` üzerindeki görünüm ister; `hexToBytes`'ın dönüşü genel `ArrayBufferLike`'tır. */
const bytesOf = (hex: string) => new Uint8Array(hexToBytes(hex));

/**
 * Şifrelemenin ek doğrulanan verisi: biçim, sahip ve türetme parametreleri. Dosyanın başlığı değiştirilir
 * ya da başka bir cüzdanın adına yazılırsa çözme başarısız olur.
 */
const associatedData = (owner: string, kdf: Kdf) =>
  encoder.encode(JSON.stringify([VAULT_FORMAT, 1, owner, kdf.name, kdf.hash, kdf.iterations, kdf.salt]));

async function deriveKey(passphrase: string, kdf: Kdf): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: kdf.hash, salt: bytesOf(kdf.salt), iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Yeni parolanın sorunu; uygunsa null. */
export function passphraseProblem(passphrase: string, confirmation?: string): string | null {
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH)
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters; a passphrase of several words is easiest to keep.`;
  if (confirmation !== undefined && confirmation !== passphrase) return 'The two passphrases differ.';
  return null;
}

/** Yeni depo anahtarı: türetme salt'ı rastgele 16 bayt. */
export async function createVaultKey(
  owner: string,
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<VaultKey> {
  const kdf: Kdf = {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  };
  return { owner, kdf, key: await deriveKey(passphrase, kdf) };
}

/** Kayıtları şifreler; her şifrelemede yeni 12 baytlık IV. */
export async function sealVault(vaultKey: VaultKey, entries: readonly TravelRuleEntry[]): Promise<VaultFile> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ entries }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: associatedData(vaultKey.owner, vaultKey.kdf) },
    vaultKey.key,
    plaintext,
  );
  return {
    format: VAULT_FORMAT,
    version: 1,
    owner: vaultKey.owner,
    kdf: vaultKey.kdf,
    cipher: { name: 'AES-GCM', iv: bytesToHex(iv) },
    ciphertext: bytesToHex(new Uint8Array(ciphertext)),
  };
}

export type VaultOpen = { ok: true; key: VaultKey; entries: TravelRuleEntry[] } | { ok: false; error: string };

/** Zarfı parolayla açar. Yanlış parola ile değiştirilmiş dosya ayırt edilemez (AEAD); ikisi de aynı hatayı verir. */
export async function openVault(file: VaultFile, passphrase: string): Promise<VaultOpen> {
  const key = await deriveKey(passphrase, file.kdf);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytesOf(file.cipher.iv), additionalData: associatedData(file.owner, file.kdf) },
      key,
      bytesOf(file.ciphertext),
    );
  } catch {
    return { ok: false, error: 'Wrong passphrase, or the file was changed.' };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return { ok: false, error: 'The decrypted records are not readable.' };
  }
  const parsed = PlaintextSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'The decrypted records are not Square Travel Rule records.' };
  return { ok: true, key: { owner: file.owner, kdf: file.kdf, key }, entries: parsed.data.entries };
}

export type VaultFileRead = { ok: true; file: VaultFile } | { ok: false; error: string };

/** Dışa aktarılmış dosyayı okur; yalnızca aynı kurum cüzdanının deposu kabul edilir. */
export function readVaultFile(text: string, owner: string): VaultFileRead {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON.' };
  }
  const parsed = VaultFileSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'The file is not a Square Travel Rule export.' };
  if (parsed.data.owner !== owner)
    return { ok: false, error: `This export belongs to ${parsed.data.owner}, not to the connected wallet.` };
  return { ok: true, file: parsed.data };
}

export function loadVault(owner: string): VaultFile | null {
  let text: string | null;
  try {
    text = window.localStorage.getItem(vaultKeyName(owner));
  } catch {
    return null;
  }
  if (!text) return null;
  const read = readVaultFile(text, owner);
  return read.ok ? read.file : null;
}

/** Yazılamazsa (gizli pencere, engellenmiş site verisi) false: arayüz dışa aktarmanın önemini vurgular. */
export function saveVault(file: VaultFile): boolean {
  try {
    window.localStorage.setItem(vaultKeyName(file.owner), JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}

/** İki kayıt listesinin birleşimi; aynı iş ve commitment bir kez, ilk listedeki kalır. */
export function mergeEntries(
  current: readonly TravelRuleEntry[],
  incoming: readonly TravelRuleEntry[],
): TravelRuleEntry[] {
  const seen = new Set(current.map((entry) => `${entry.job}:${entry.commitment}`));
  return [...current, ...incoming.filter((entry) => !seen.has(`${entry.job}:${entry.commitment}`))];
}
