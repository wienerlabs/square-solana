// Service name and version reported by /health and the OpenAPI document.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
  throw new Error('package.json must declare name and version');
}

export const packageInfo = Object.freeze({ name: pkg.name, version: pkg.version });
