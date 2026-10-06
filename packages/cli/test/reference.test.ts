// Komut referansı (docs/cli.md) komut tablosundan üretilir; belge güncel olmalı (scripts/reference.mjs).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('docs/cli.md', () => {
  it('komut tablosundan üretilen referansla aynı', () => {
    const script = fileURLToPath(new URL('../scripts/reference.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr.replace(/^bigint:.*\n/m, '')).toBe('');
    expect(result.status).toBe(0);
  });
});
