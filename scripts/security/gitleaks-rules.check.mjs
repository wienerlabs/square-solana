// BC-13: .gitleaks.toml'daki Solana anahtar kurallarının testi; gitleaks ikilisini ister (CI'da
// security.yml kurar). `*.test.mjs` değil: lisans iş akışı scripts/**/*.test.mjs'i gitleaks'siz koşar.
//
//   node --test scripts/security/gitleaks-rules.check.mjs
//
// Anahtar benzeri girdiler her koşuda rastgele üretilir ve geçici dizinde kalır; depoya girmez. Yalnızca bu
// deponun kuralları denenir: gitleaks'in varsayılan kuralları (ör. generic-api-key) entropi ve stopword
// filtreleriyle çalışır, rastgele girdide sonuçları kararsızdır.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gitleaksArgs } from './gitleaks.mjs';

const CONFIG = fileURLToPath(new URL('../../.gitleaks.toml', import.meta.url));
const bytes = () => Array.from(randomBytes(64));

/** Dosya adı → beklenen kural (null: bulgu olmamalı). */
const CASES = {
  'id.json': [JSON.stringify(bytes()), 'solana-keypair-file'],
  'deploy-authority.json': [`${JSON.stringify(bytes(), null, 2)}\n`, 'solana-keypair-file'],
  'config.json': [JSON.stringify({ name: 'x', secretKey: bytes() }, null, 2), 'solana-secret-key-array'],
  'load.ts': [
    `const k = Keypair.fromSecretKey(Uint8Array.from([${bytes().join(', ')}]));\n`,
    'solana-secret-key-array',
  ],
  'signer.ts': [
    `export const signer = Keypair.fromSecretKey(\n  new Uint8Array([\n    ${bytes().join(',\n    ')}\n  ]),\n);\n`,
    'solana-secret-key-array',
  ],
  'local.env': [`PRIVATE_KEY=[${bytes().join(',')}]\n`, 'solana-secret-key-array'],
  'key.rs': [`let secret_key: [u8; 64] = [${bytes().join(', ')}];\n`, 'solana-secret-key-array'],
  // Adsız 64 baytlık açık veriler: doğrulama anahtarı, ispat noktası, belge örneği.
  'vk.rs': [`pub const ALPHA_G1: [u8; 64] = [${bytes().join(', ')}];\n`, null],
  'proof.json': [JSON.stringify({ proof_a: bytes(), public_inputs: [bytes().slice(0, 32)] }, null, 2), null],
  'note.md': ['A keypair file holds 64 numbers, e.g. `[12, 7, ...]`.\n', null],
};

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'square-gitleaks-'));
  dirs.push(dir);
  for (const [file, [content]] of Object.entries(CASES)) writeFileSync(join(dir, file), content);
  return dir;
}

function findings(args, cwd) {
  const result = spawnSync('gitleaks', [...args, '--report-format', 'json', '--report-path', '-'], {
    cwd,
    encoding: 'utf8',
  });
  assert.ok(!result.error, `gitleaks çalıştırılamadı: ${result.error?.message}`);
  const found = new Map();
  for (const f of JSON.parse(result.stdout || '[]')) found.set(f.File.split('/').at(-1), f.RuleID);
  return { found, status: result.status };
}

function assertCases(found) {
  for (const [file, [, rule]] of Object.entries(CASES)) {
    assert.equal(found.get(file) ?? null, rule, file);
  }
}

test('dizin taraması: anahtarlar yakalanıyor, adsız açık diziler yakalanmıyor', () => {
  const dir = fixtureDir();
  const { found } = findings(['dir', dir, '--config', CONFIG, '--no-banner', '--exit-code', '0'], dir);
  assertCases(found);
});

test("pre-commit kipi (kancanın argümanları) staged anahtarı yakalayıp commit'i durduruyor", () => {
  const dir = fixtureDir();
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', '-A').status, 0);
  const args = gitleaksArgs('staged').map((a) => (a === '.gitleaks.toml' ? CONFIG : a));
  const { found, status } = findings(args, dir);
  assertCases(found);
  assert.equal(status, 1);
});
