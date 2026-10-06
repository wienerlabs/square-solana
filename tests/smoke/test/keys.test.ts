import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClusterConfig } from '../src/config.js';
import { assertOutsideRepo, loadKeypair, loadRoleKeys, REPO_ROOT, roleKey } from '../src/keys.js';
import { rawConfig, tempDir, writeKey } from './helpers.js';

describe('anahtar dosyaları', () => {
  it('REPO_ROOT deponun köküdür', () => {
    expect(REPO_ROOT.endsWith('tests/smoke')).toBe(false);
    expect(() => assertOutsideRepo(join(REPO_ROOT, 'tests/smoke/package.json'))).toThrow(/depo içinde/);
  });

  it('solana-keygen biçimini okur', () => {
    const dir = tempDir();
    const repo = tempDir('square-smoke-repo-');
    const keypair = writeKey(dir, 'payer');
    expect(loadKeypair(join(dir, 'payer.json'), repo).publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it('depo içindeki yolu (sembolik bağla da olsa) dosyayı okumadan reddeder', () => {
    const repo = tempDir('square-smoke-repo-');
    mkdirSync(join(repo, 'keys'));
    writeKey(join(repo, 'keys'), 'payer');
    expect(() => loadKeypair(join(repo, 'keys/payer.json'), repo)).toThrow(/depo içinde/);
    expect(() => loadKeypair(repo, repo)).toThrow(/depo içinde/);
    const outside = tempDir();
    symlinkSync(join(repo, 'keys/payer.json'), join(outside, 'link.json'));
    expect(() => loadKeypair(join(outside, 'link.json'), repo)).toThrow(/depo içinde/);
  });

  it('bozuk ya da yanlış biçimli dosya hata verir', () => {
    const dir = tempDir();
    const repo = tempDir('square-smoke-repo-');
    writeFileSync(join(dir, 'short.json'), JSON.stringify([1, 2, 3]));
    writeFileSync(join(dir, 'bad.json'), 'not json');
    writeFileSync(join(dir, 'range.json'), JSON.stringify(Array.from({ length: 64 }, () => 256)));
    expect(() => loadKeypair(join(dir, 'short.json'), repo)).toThrow(/64 baytlık/);
    expect(() => loadKeypair(join(dir, 'range.json'), repo)).toThrow(/64 baytlık/);
    expect(() => loadKeypair(join(dir, 'bad.json'), repo)).toThrow(/okunamadı/);
    expect(() => loadKeypair(join(dir, 'missing.json'), repo)).toThrow(/okunamadı/);
  });

  it('rol anahtarlarını yükler; eksik rol adıyla bildirilir', () => {
    const dir = tempDir();
    const repo = tempDir('square-smoke-repo-');
    mkdirSync(join(dir, 'keys'));
    const payer = writeKey(join(dir, 'keys'), 'payer');
    writeKey(join(dir, 'keys'), 'screener');
    const keys = loadRoleKeys(parseClusterConfig(rawConfig(), dir), repo);
    expect(roleKey(keys, 'payer').publicKey.equals(payer.publicKey)).toBe(true);
    expect(() => roleKey(keys, 'keeper')).toThrow(/"keeper" anahtarı/);
  });
});
