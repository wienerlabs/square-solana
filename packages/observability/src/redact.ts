// Log'a yazılmadan önce gizli verinin maskelenmesi. İki katman: adı gizli bir alanı ima eden anahtarların
// değeri tümüyle, değeri gizli bir biçime uyan dizelerin ilgili kısmı (`Bearer` belirteci, URL'deki
// kullanıcı bilgisi ve anahtar parametreleri, Stripe anahtarları, PEM özel anahtarı, Solana gizli anahtarı)
// maskelenir. Bayt dizileri içerikleri yerine uzunluklarıyla yazılır.
//
// 64 baytlık base58 dizeler değerden maskelenmez: aynı biçim Solana işlem imzasıdır ve imzalar
// herkese açıktır. Gizli anahtarlar alan adlarından (`secretKey`, `keypair`, `privateKey`) maskelenir.

/** Maskelenen değerin yerine yazılan metin. */
export const REDACTED = '[REDACTED]';

/**
 * Değeri tümüyle maskelenen alan adları: parola, belirteç, API anahtarı, yetki başlığı, çerez, özel ya da
 * gizli anahtar, keypair, anımsatıcı, salt (politika ve Travel Rule salt'ları), witness (politika), kimlik
 * bilgisi. Ad küçük harfe çevrilip `-` / `_` atılarak karşılaştırılır.
 */
const SECRET_KEY =
  /(secret|password|passwd|passphrase|token|apikey|authorization|cookie|privatekey|keypair|mnemonic|seedphrase|salt|witness|credential)/;

const normalizeKey = (key: string) => key.toLowerCase().replace(/[-_]/g, '');

export const isSecretKey = (key: string): boolean => SECRET_KEY.test(normalizeKey(key));

/** URL sorgusunda değeri maskelenen parametreler (ör. RPC sağlayıcısının `api-key`'i). */
const SECRET_QUERY = /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token|secret|auth|signature|sig)=)[^&#\s"']+/gi;

const VALUE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // PEM özel anahtarı (tüm blok).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Yetki başlığındaki belirteç.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // URL'deki kullanıcı bilgisi: scheme://user:pass@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/gi, `$1${REDACTED}@`],
  // Stripe gizli, kısıtlı ve webhook anahtarları.
  [/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]+/g, REDACTED],
  // Keypair dosyasının içeriği: 64 sayılık JSON dizisi.
  [/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g, REDACTED],
];

/** Dizedeki gizli biçimleri maskeler; geri kalanı korunur. */
export function redactString(value: string): string {
  const masked = VALUE_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  return masked.replace(SECRET_QUERY, `$1${REDACTED}`);
}

/** Keypair dosyasının dizisi: 0–255 arası 64 tamsayı. */
const isKeypairBytes = (value: readonly unknown[]) =>
  value.length === 64 &&
  value.every((item) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 255);

/** İç içe değerin en fazla derinliği; daha derini kısaltılır. */
const MAX_DEPTH = 8;

function redactError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: error.name, message: redactString(error.message) };
  if (error.stack) fields['stack'] = redactString(error.stack);
  if ('cause' in error && error.cause !== undefined) fields['cause'] = redactValue(error.cause, seen, depth + 1);
  return fields;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? String(value) : value;
  }
  if (ArrayBuffer.isView(value)) return `[bytes:${value.byteLength}]`;
  if (value instanceof ArrayBuffer) return `[bytes:${value.byteLength}]`;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) return redactError(value, seen, depth);
  if (value instanceof Date) return value.toISOString();
  // Açık anahtarlar (`PublicKey`) gizli değildir; base58 biçimiyle yazılır.
  const base58 = (value as { toBase58?: unknown }).toBase58;
  if (typeof base58 === 'function') return String(base58.call(value));
  if (Array.isArray(value)) {
    return isKeypairBytes(value) ? REDACTED : value.map((item) => redactValue(item, seen, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSecretKey(key) ? REDACTED : redactValue(item, seen, depth + 1)]),
  );
}

/** Log alanlarını maskeler: gizli adlı alanların değeri, dizelerdeki gizli biçimler. Girdi değişmez. */
export function redact(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return redactValue(fields, new WeakSet(), 0) as Record<string, unknown>;
}
