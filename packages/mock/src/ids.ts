// Deterministik sahte değerler. Etiketten türetilir; tarayıcıda ve Node'da senkron, bağımlılıksız
// çalışır. Kriptografik değildir: amaç her etikete sabit, tekil ve şemaya uygun bir değer vermek.

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** `Pubkey::default()`; atanmamış adres alanları için (Anchor JSON'unda 32 adet `1`). */
export const ZERO_ADDRESS = '11111111111111111111111111111111';

/** Atanmamış 32 baytlık hash alanları. */
export const ZERO_HEX32 = '0'.repeat(64);

/** FNV-1a tohumlu xorshift32 akışından `n` bayt. İlk bayt sıfır olmaz: base58 uzunluğu sabit kalır. */
export function mockBytes(label: string, n: number): Uint8Array {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let x = h || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  out[0] = (out[0] ?? 0) | 0x01;
  return out;
}

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = BASE58[Number(n % 58n)] + s;
    n /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + s;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** 32 baytlık base58 adres. */
export const mockAddress = (label: string): string => base58(mockBytes(`address:${label}`, 32));

/** 64 baytlık base58 tx imzası. */
export const mockSignature = (label: string): string => base58(mockBytes(`signature:${label}`, 64));

/** `n` bayt, küçük harf hex. */
export const mockHex = (label: string, n: number): string => hex(mockBytes(`hex:${label}`, n));

/** 32 bayt, küçük harf hex. */
export const mockHex32 = (label: string): string => mockHex(label, 32);

/** SHA-256, küçük harf hex (Web Crypto; tarayıcı ve Node ≥ 20). */
export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}
