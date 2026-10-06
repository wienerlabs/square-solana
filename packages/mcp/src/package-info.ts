// MCP'de bildirilen sunucu adı ve sürümü (package.json).
import { readFileSync } from 'node:fs';

const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** package.json içeriğinden ad ve sürüm. */
export function parsePackageInfo(value: unknown): { name: string; version: string } {
  const { name, version } = (value ?? {}) as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('package.json ad ve sürüm bildirmeli');
  }
  return { name, version };
}

export const packageInfo = Object.freeze(parsePackageInfo(pkg));
