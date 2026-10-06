// MCP üzerinden bildirilen sunucu adı ve sürümü package.json'dan okunur.
import { readFileSync } from 'node:fs';

interface PackageInfo {
  name: string;
  version: string;
}

function loadPackageInfo(): PackageInfo {
  // dist/package-info.js ve src/package-info.ts paket kökünün bir altında.
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    typeof (raw as Record<string, unknown>).name !== 'string' ||
    typeof (raw as Record<string, unknown>).version !== 'string'
  ) {
    throw new Error('package.json name ve version içermeli');
  }
  const { name, version } = raw as PackageInfo;
  return { name, version };
}

export const packageInfo: PackageInfo = loadPackageInfo();
