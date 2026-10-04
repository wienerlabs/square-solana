// Zincirdeki doğrulayıcının (crates/square-common, `merkle`) test ettiği vektörler bu paketin
// uygulamasından üretilir; dosya güncel olmalı (scripts/buyer-vectors.mjs).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('buyer-merkle-vectors.json', () => {
  it('bu paketin ürettiği ağaç ve kanıtlarla aynı', () => {
    const script = fileURLToPath(new URL('../scripts/buyer-vectors.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
