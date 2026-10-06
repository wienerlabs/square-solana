// Rol anahtarları: `solana-keygen` biçimindeki JSON dosyalarından (64 baytlık dizi) okunur. Anahtar
// dosyası depoda olamaz (runbook "Kurallar"; `.gitignore` ve gitleaks kancası ikinci savunmadır): depo
// içindeki bir yol, dosya okunmadan reddedilir.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import type { ClusterConfig, KeyRole } from './config.js';

/** Deponun kökü (`tests/smoke/{src,dist}/` → iki üst dizin). */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

const realOrSelf = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Yol depo içindeyse fırlatır (sembolik bağlar çözülerek). */
export function assertOutsideRepo(path: string, repoRoot: string = REPO_ROOT): void {
  const rel = relative(realOrSelf(repoRoot), realOrSelf(path));
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    throw new Error(`anahtar dosyası depo içinde olamaz: ${path} (secret store'dan repo dışına yazın)`);
  }
}

export function loadKeypair(path: string, repoRoot: string = REPO_ROOT): Keypair {
  assertOutsideRepo(path, repoRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`anahtar dosyası okunamadı (${path}): ${(error as Error).message}`, { cause: error });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new Error(`anahtar dosyası solana-keygen biçiminde değil (64 baytlık dizi): ${path}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

export type RoleKeys = Partial<Record<KeyRole, Keypair>>;

/** Yapılandırmadaki bütün anahtar yollarını yükler. */
export function loadRoleKeys(config: ClusterConfig, repoRoot: string = REPO_ROOT): RoleKeys {
  const keys: RoleKeys = {};
  for (const [role, path] of Object.entries(config.keys) as [KeyRole, string | undefined][]) {
    if (path !== undefined) keys[role] = loadKeypair(path, repoRoot);
  }
  return keys;
}

/** Rolün anahtarı; yoksa fırlatır. */
export function roleKey(keys: RoleKeys, role: KeyRole): Keypair {
  const key = keys[role];
  if (!key) throw new Error(`"${role}" anahtarı yapılandırmada yok`);
  return key;
}
