// Politika sırrı ve taslakları bu tarayıcıda, kurum cüzdanı başına tutulur; sunucuya gönderilmez.
// Sır, 8 salt'ın tek kaynağıdır (API sözleşmesi, "Politika salt'ları"). Kaybolursa politikanın ispatı
// üretilemez ve release'ler gerçekleşmez; bu yüzden yedek dosyası sırla birlikte taslakları ve alıcı
// salt'larını da taşır (adım 7'deki kurum yazılımı ve alıcıların kanıtları bunlara ihtiyaç duyar).
import { z } from 'zod';
import { PolicyDraftSchema, bytesToHex, hexToBytes, type PolicyDraft } from './policy-draft';

const secretKey = (owner: string) => `square-policy-secret:${owner}`;
const draftsKey = (owner: string) => `square-policies:${owner}`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Yazılamazsa (gizli pencere, engellenmiş site verisi) false: arayüz yedeğin önemini vurgular. */
function write(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadSecret(owner: string): Uint8Array | null {
  const hex = read(secretKey(owner));
  return hex && /^[0-9a-f]{64}$/.test(hex) ? hexToBytes(hex) : null;
}

export const saveSecret = (owner: string, secret: Uint8Array) => write(secretKey(owner), bytesToHex(secret));

export function loadDrafts(owner: string): PolicyDraft[] {
  const text = read(draftsKey(owner));
  if (!text) return [];
  try {
    const parsed = z.array(PolicyDraftSchema).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const saveDrafts = (owner: string, drafts: readonly PolicyDraft[]) =>
  write(draftsKey(owner), JSON.stringify(drafts));

export const BACKUP_FORMAT = 'square-policy-backup';

const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  owner: z.string(),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  policies: z.array(PolicyDraftSchema),
});
export type PolicyBackup = z.infer<typeof BackupSchema>;

export function createBackup(owner: string, secret: Uint8Array, drafts: readonly PolicyDraft[]): PolicyBackup {
  return { format: BACKUP_FORMAT, version: 1, owner, secret: bytesToHex(secret), policies: [...drafts] };
}

export type BackupImport = { ok: true; secret: Uint8Array; drafts: PolicyDraft[] } | { ok: false; error: string };

/** Yedeği yalnızca aynı kurum cüzdanına geri yükler; başka bir cüzdanın sırrı bu cüzdanın politikalarına ait değildir. */
export function readBackup(text: string, owner: string): BackupImport {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The file is not JSON.' };
  }
  const parsed = BackupSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: 'The file is not a Square policy backup.' };
  if (parsed.data.owner !== owner) {
    return { ok: false, error: `This backup belongs to ${parsed.data.owner}, not to the connected wallet.` };
  }
  return { ok: true, secret: hexToBytes(parsed.data.secret), drafts: parsed.data.policies };
}
