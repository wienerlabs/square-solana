// Girdi ve çıktı yardımcıları: keypair ve JSON dosyaları, adres ve tutar ayrıştırma, sonuç yazdırma.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { expandPath } from './config.js';

/** Çıktı kanalları; testler kendi yazıcılarını verir. */
export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: Io = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Kullanıcının düzeltebileceği hata: yalnızca mesajı yazdırılır. */
export class CliError extends Error {
  override readonly name = 'CliError';
}

/** solana-keygen biçimindeki (64 baytlık JSON dizi) keypair dosyası. */
export function loadKeypair(path: string): Keypair {
  const target = expandPath(path);
  if (!existsSync(target)) throw new CliError(`keypair dosyası yok: ${target}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new CliError(`keypair dosyası JSON değil: ${target}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new CliError(`keypair dosyası solana-keygen biçiminde değil (64 baytlık dizi): ${target}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

export function readJson(path: string, label: string): unknown {
  const target = expandPath(path);
  if (!existsSync(target)) throw new CliError(`${label} dosyası yok: ${target}`);
  try {
    return JSON.parse(readFileSync(target, 'utf8'));
  } catch (error) {
    throw new CliError(`${label} dosyası JSON değil (${target}): ${(error as Error).message}`);
  }
}

export function readBytes(path: string, label: string): Uint8Array {
  const target = expandPath(path);
  if (!existsSync(target)) throw new CliError(`${label} dosyası yok: ${target}`);
  return new Uint8Array(readFileSync(target));
}

/** Sır ya da liste dosyası: yalnızca sahibi okur, var olan dosyanın üstüne yazılmaz. */
export function writePrivate(path: string, content: string): string {
  const target = expandPath(path);
  if (existsSync(target)) throw new CliError(`dosya zaten var, üstüne yazılmaz: ${target}`);
  writeFileSync(target, content, { mode: 0o600 });
  return target;
}

export function address(value: string | undefined, label: string): PublicKey {
  if (!value) throw new CliError(`--${label} gerekli`);
  try {
    return new PublicKey(value);
  } catch {
    throw new CliError(`--${label} base58 adres değil: ${value}`);
  }
}

export function required(value: string | undefined, label: string): string {
  if (value === undefined || value === '') throw new CliError(`--${label} gerekli`);
  return value;
}

/** Taban birimde tutar (u64). */
export function amount(value: string | undefined, label: string): bigint {
  const text = required(value, label);
  if (!/^\d+$/.test(text)) throw new CliError(`--${label} taban birimde tamsayı olmalı: ${text}`);
  const parsed = BigInt(text);
  if (parsed >= 2n ** 64n) throw new CliError(`--${label} u64 aralığı dışında: ${text}`);
  return parsed;
}

export function integer(value: string | undefined, label: string): number {
  const text = required(value, label);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new CliError(`--${label} negatif olmayan tamsayı olmalı: ${text}`);
  }
  return Number(text);
}

/** 32 baytlık hex (ör. hash). */
export function bytes32(value: string | undefined, label: string): Uint8Array {
  const text = required(value, label);
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new CliError(`--${label} 32 baytlık hex olmalı`);
  return Uint8Array.from(Buffer.from(text, 'hex'));
}

/** Unix saniyesi ya da `+<saniye>` (şimdiden itibaren). */
export function timestamp(value: string | undefined, label: string, now: number): number {
  const text = required(value, label);
  const relative = /^\+(\d+)$/.exec(text);
  if (relative) return now + Number(relative[1]);
  return integer(text, label);
}

export const hex = (bytes: Uint8Array | readonly number[]) => Buffer.from(bytes).toString('hex');

/** Sonuç değerlerini yazdırılabilir hâle getirir: adres base58, bigint ondalık, bayt dizisi hex. */
export function printable(value: unknown): unknown {
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return hex(value);
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, printable(v)]));
  }
  return value;
}

/** Komut sonucu: `--json` ile tek JSON nesnesi, değilse hizalı `alan  değer` satırları. */
export function printResult(io: Io, result: Record<string, unknown>, json: boolean): void {
  const value = printable(result) as Record<string, unknown>;
  if (json) {
    io.stdout(`${JSON.stringify(value)}\n`);
    return;
  }
  const width = Math.max(...Object.keys(value).map((k) => k.length));
  for (const [key, item] of Object.entries(value)) {
    const text = item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item);
    io.stdout(`${key.padEnd(width)}  ${text}\n`);
  }
}
