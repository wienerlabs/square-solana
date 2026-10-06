import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { railwayConfig, services, workspaceDeps, workspacePackages } from './railway.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('her Dockerfile bir servis; web ve API dahil', () => {
  const list = services(ROOT);
  for (const app of ['api', 'indexer', 'keeper', 'prover', 'screener', 'web']) assert.ok(list.includes(app), app);
});

test('workspace bağımlılıkları geçişli: keeper db ve sdk üzerinden types’ı izler', () => {
  const deps = workspaceDeps(ROOT, 'apps/keeper', workspacePackages(ROOT));
  for (const dir of ['db', 'packages/sdk', 'packages/types', 'packages/config']) assert.ok(deps.includes(dir), dir);
  assert.ok(!deps.includes('apps/keeper'));
});

test('web: elle yazılmış eski tanımla aynı yollar ve /healthz; diğerleri /ready', () => {
  const web = railwayConfig(ROOT, 'web');
  assert.equal(web.deploy.healthcheckPath, '/healthz');
  assert.deepEqual(
    [...web.build.watchPatterns].sort(),
    [
      '/apps/web/**',
      '/circuits/payment-compliance/artifacts/manifest.json',
      '/package.json',
      '/packages/config/**',
      '/packages/identity/**',
      '/packages/policy/**',
      '/packages/sdk/**',
      '/packages/types/**',
      '/pnpm-lock.yaml',
      '/pnpm-workspace.yaml',
    ].sort(),
  );
  assert.equal(railwayConfig(ROOT, 'api').deploy.healthcheckPath, '/ready');
  assert.ok(railwayConfig(ROOT, 'prover').build.watchPatterns.includes('/circuits/payment-compliance/**'));
});

test('commit’lenmiş dosyalar türetilenle aynı', () => {
  for (const app of services(ROOT)) {
    const file = JSON.parse(readFileSync(new URL(`../../apps/${app}/railway.json`, import.meta.url), 'utf8'));
    assert.deepEqual(file, railwayConfig(ROOT, app), app);
  }
});
