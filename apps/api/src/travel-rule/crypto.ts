// Travel Rule kaydının zarf şifrelemesi (ADR 0017), `@squaresdk/solana-hardening`'in `SecretBox`'ı (AES-256-GCM,
// `sq1.<anahtar>.<iv>.<şifreli veri + etiket>`) üzerine. Kayıt, kendi rastgele 32 baytlık veri anahtarıyla
// şifrelenir. Veri anahtarı ana anahtar halkasıyla (`API_TRAVEL_RULE_KEYS`) sarılır. Ek doğrulanan veri (AAD),
// şifreli kaydı job'a ve commitment'a, sarılmış anahtarı job'a bağlar: başka bir satıra kopyalanan değer
// açılmaz. Döndürmede yeni anahtar etkin yapılır. Bakım eski anahtarla sarılmış veri anahtarlarını yeniden
// sarar (`rewrap`); kaydın kendisi yeniden şifrelenmez.
import { randomBytes } from 'node:crypto';
import { createSecretBox, type SecretBox } from '@squaresdk/solana-hardening';

/** Kayda özgü veri anahtarı (AES-256). */
const DATA_KEY_BYTES = 32;
/** Veri anahtarının tek anahtarlı kutudaki kimliği; şifreli değerin biçiminde görünür. */
const DATA_KEY_ID = 'record';

/** Şifreli kayıt: `SecretBox` değerleri ve sarmada kullanılan ana anahtarın kimliği. */
export interface Sealed {
  readonly ciphertext: string;
  readonly keyId: string;
  readonly wrappedKey: string;
}

/** Şifreli verinin bağlandığı satır. */
export interface SealContext {
  readonly job: string;
  readonly commitment: string;
}

const recordAad = ({ job, commitment }: SealContext) => `square/travel-rule/record/v1|${job}|${commitment}`;
const keyAad = (job: string) => `square/travel-rule/key/v1|${job}`;
const dataBox = (dataKey: Uint8Array) =>
  createSecretBox({ keys: { [DATA_KEY_ID]: dataKey }, activeKeyId: DATA_KEY_ID });

export function seal(box: SecretBox, plaintext: Uint8Array, context: SealContext): Sealed {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    return {
      ciphertext: dataBox(dataKey).seal(plaintext, recordAad(context)),
      keyId: box.activeKeyId,
      wrappedKey: box.seal(dataKey, keyAad(context.job)),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function open(
  box: SecretBox,
  sealed: Pick<Sealed, 'ciphertext' | 'wrappedKey'>,
  context: SealContext,
): Uint8Array {
  const dataKey = box.open(sealed.wrappedKey, keyAad(context.job));
  try {
    return dataBox(dataKey).open(sealed.ciphertext, recordAad(context));
  } finally {
    dataKey.fill(0);
  }
}

/** Veri anahtarını etkin ana anahtarla yeniden sarar. */
export function rewrap(box: SecretBox, wrappedKey: string, job: string): Pick<Sealed, 'keyId' | 'wrappedKey'> {
  const dataKey = box.open(wrappedKey, keyAad(job));
  try {
    return { keyId: box.activeKeyId, wrappedKey: box.seal(dataKey, keyAad(job)) };
  } finally {
    dataKey.fill(0);
  }
}
