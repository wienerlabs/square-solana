// Screener authority keypair'i: `RegistryConfig.screener_authority`'nin imzalayan anahtarı. Değer repoda
// tutulmaz; secret store'dan ortam değişkeni (`SCREENER_AUTHORITY_KEYPAIR`) ya da bağlanan secret
// dosyası (`SCREENER_AUTHORITY_KEYPAIR_PATH`) olarak gelir. Biçim solana-keygen'in JSON'udur (64 baytlık
// dizi: gizli anahtar + açık anahtar). Hata mesajları değeri içermez.
import { statSync, readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';

const SECRET_KEY_BYTES = 64;
const Bytes = z.array(z.number().int().min(0).max(255)).length(SECRET_KEY_BYTES);
/** Grup ya da herkes için okunabilir dosya izni. */
const WIDE_PERMISSIONS = 0o077;

export interface LoadedKeypair {
  readonly keypair: Keypair;
  /** Anahtarı açmayı engellemeyen uyarılar (ör. dosya izni geniş). */
  readonly warnings: readonly string[];
}

/** solana-keygen JSON'u → Keypair; açık anahtar kısmı gizli anahtarla tutarlı olmalı. */
export function parseKeypair(text: string, what: string): Keypair {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${what}: JSON değil (solana-keygen biçiminde 64 baytlık dizi bekleniyor)`);
  }
  const bytes = Bytes.safeParse(value);
  if (!bytes.success) throw new Error(`${what}: 64 baytlık dizi bekleniyor`);
  try {
    return Keypair.fromSecretKey(Uint8Array.from(bytes.data));
  } catch {
    throw new Error(`${what}: açık anahtar gizli anahtarla tutarlı değil`);
  }
}

export function loadAuthorityKeypair(
  source: { kind: 'inline'; value: string } | { kind: 'file'; path: string },
): LoadedKeypair {
  if (source.kind === 'inline') {
    return { keypair: parseKeypair(source.value, 'SCREENER_AUTHORITY_KEYPAIR'), warnings: [] };
  }
  let text: string;
  let mode: number;
  try {
    text = readFileSync(source.path, 'utf8');
    mode = statSync(source.path).mode;
  } catch (error) {
    // Dosya sistemi hatası yalnızca yolu ve kodu taşır; içerik okunmadı.
    throw new Error(`SCREENER_AUTHORITY_KEYPAIR_PATH okunamadı: ${(error as NodeJS.ErrnoException).code ?? 'hata'}`, {
      cause: error,
    });
  }
  const warnings =
    (mode & WIDE_PERMISSIONS) === 0
      ? []
      : [`keypair dosyasının izni ${(mode & 0o777).toString(8)}: yalnızca servis kullanıcısı okuyabilmeli (600)`];
  return { keypair: parseKeypair(text, 'SCREENER_AUTHORITY_KEYPAIR_PATH'), warnings };
}
