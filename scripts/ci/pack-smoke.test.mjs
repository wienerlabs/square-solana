import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXCLUDED,
  PUBLISHABLE,
  checkClassification,
  consumerManifest,
  exportSpecifiers,
  exportTargets,
  unresolvedFromLock,
} from './pack-smoke.mjs';

test('yayınlanabilir ve dışlanan listeler çakışmaz', () => {
  assert.deepEqual(
    PUBLISHABLE.filter((name) => name in EXCLUDED),
    [],
  );
  for (const [name, reason] of Object.entries(EXCLUDED)) assert.ok(reason.length > 0, name);
});

test('her workspace paketi sınıflandırılmış olmalı', () => {
  assert.deepEqual(checkClassification(['@a/x', '@a/y'], ['@a/x'], { '@a/y': 'gerekçe' }), []);
  assert.deepEqual(checkClassification(['@a/x', '@a/z'], ['@a/x'], {}), [
    '@a/z sınıflandırılmamış: scripts/ci/pack-smoke.mjs içinde PUBLISHABLE ya da EXCLUDED listesine ekleyin',
  ]);
});

test('listede olup repoda olmayan paket hata verir', () => {
  assert.deepEqual(checkClassification(['@a/x'], ['@a/x', '@a/gone'], { '@a/old': 'g' }), [
    '@a/gone PUBLISHABLE listesinde ama repoda yok',
    '@a/old EXCLUDED listesinde ama repoda yok',
  ]);
});

test('exports alt yolları import belirleyicisine çevrilir', () => {
  assert.deepEqual(exportSpecifiers('@a/x', { '.': { types: './d.d.ts', import: './i.js' }, './testing': {} }), [
    '@a/x',
    '@a/x/testing',
  ]);
  assert.deepEqual(exportSpecifiers('@a/x', './i.js'), ['@a/x']);
  assert.deepEqual(exportSpecifiers('@a/x', { types: './d.d.ts', import: './i.js' }), ['@a/x']);
  assert.deepEqual(exportSpecifiers('@a/x', { '.': './i.js', './*': './*.js', './package.json': './package.json' }), [
    '@a/x',
  ]);
});

test('exports hedef dosyaları toplanır', () => {
  assert.deepEqual(
    exportTargets({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './testing': { types: './dist/testing.d.ts', import: './dist/testing.js' },
    }),
    ['./dist/index.d.ts', './dist/index.js', './dist/testing.d.ts', './dist/testing.js'],
  );
  assert.deepEqual(exportTargets('./dist/index.js'), ['./dist/index.js']);
});

test("tüketici projesi yalnızca yerel tarball'ları kullanır", () => {
  const manifest = consumerManifest({ '@a/x': '/t/a-x-0.1.0.tgz', '@a/y': '/t/a-y-0.1.0.tgz' });
  assert.deepEqual(manifest.dependencies, { '@a/x': 'file:/t/a-x-0.1.0.tgz', '@a/y': 'file:/t/a-y-0.1.0.tgz' });
  assert.deepEqual(manifest.overrides, manifest.dependencies);
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
});

test("lockfile'da registry'den çözülen birinci taraf paket yakalanır", () => {
  const lock = {
    packages: {
      'node_modules/@a/x': { resolved: 'file:../t/a-x-0.1.0.tgz' },
      'node_modules/@a/y': { resolved: 'https://registry.npmjs.org/@a/y/-/y-0.1.0.tgz' },
    },
  };
  assert.deepEqual(unresolvedFromLock(lock, ['@a/x', '@a/y', '@a/z']), [
    '@a/y yerel tarball yerine https://registry.npmjs.org/@a/y/-/y-0.1.0.tgz adresinden çözüldü',
    "@a/z lockfile'da yok",
  ]);
});
