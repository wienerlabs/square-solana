// Zincirdeki kuralların (crates/square-common, `release`) test ettiği vektörler bu paketin
// uygulamasından üretilir; dosya güncel olmalı (scripts/release-vectors.mjs).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('release-rule-vectors.json', () => {
  it('bu paketin kurallarının verdiği kararlarla aynı', () => {
    const script = fileURLToPath(new URL('../scripts/release-vectors.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
