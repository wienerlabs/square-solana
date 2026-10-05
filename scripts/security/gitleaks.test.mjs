import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { atLeast, gitleaksArgs, parseVersion, pinnedVersion } from './gitleaks.mjs';

test("sabitlenen sürüm gitleaks.env'den okunuyor", () => {
  const env = readFileSync(new URL('./gitleaks.env', import.meta.url), 'utf8');
  assert.match(pinnedVersion(env), /^\d+\.\d+\.\d+$/);
  assert.match(env, /^GITLEAKS_SHA256=[0-9a-f]{64}$/m);
  assert.throws(() => pinnedVersion('GITLEAKS_SHA256=ab\n'), /GITLEAKS_VERSION/);
});

test('sürüm karşılaştırması', () => {
  assert.deepEqual(parseVersion('8.30.1\n'), [8, 30, 1]);
  assert.deepEqual(parseVersion('v8.30.10'), [8, 30, 10]);
  assert.equal(parseVersion('dev'), null);
  assert.equal(atLeast([8, 30, 1], [8, 30, 1]), true);
  assert.equal(atLeast([8, 31, 0], [8, 30, 1]), true);
  assert.equal(atLeast([9, 0, 0], [8, 30, 1]), true);
  assert.equal(atLeast([8, 30, 0], [8, 30, 1]), false);
  assert.equal(atLeast([8, 29, 9], [8, 30, 1]), false);
});

test('kiplerin argümanları depo yapılandırmasını açıkça veriyor', () => {
  for (const mode of ['staged', 'history']) {
    const args = gitleaksArgs(mode);
    assert.equal(args[0], 'git');
    assert.equal(args[args.indexOf('--config') + 1], '.gitleaks.toml');
    assert.equal(args[args.indexOf('--exit-code') + 1], '1');
    assert.ok(args.includes('--redact'));
  }
  assert.deepEqual(gitleaksArgs('staged').slice(0, 3), ['git', '--pre-commit', '--staged']);
  assert.ok(!gitleaksArgs('history').includes('--staged'));
  assert.throws(() => gitleaksArgs('dir'), /bilinmeyen kip/);
});
