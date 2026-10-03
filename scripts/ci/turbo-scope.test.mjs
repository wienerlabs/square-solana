import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChanges, decideScope, formatOutputs } from './turbo-scope.mjs';

test('yalnızca paket dizinleri ve belgeler değiştiyse etkilenen paketler', () => {
  const r = classifyChanges([
    'packages/types/src/a2a.ts',
    'apps/prover/src/app.ts',
    'db/prisma/schema.prisma',
    'docs/decisions/0002-mimari-yol-c-tek-anchor-workspace.md',
    'README.md',
    '.changeset/agent-sdk.md',
  ]);
  assert.equal(r.mode, 'affected');
  assert.deepEqual(r.fullTriggers, []);
});

test('testlerin okuduğu kök girdiler tam koşu ister', () => {
  for (const file of [
    'idl/square_escrow_contract.json',
    'docs/api/openapi.yaml',
    'docs/api/schemas/idl.json',
    'docs/did-aip/test-vectors.json',
    'circuits/payment-compliance/payment.circom',
  ]) {
    assert.deepEqual(classifyChanges([file]), { mode: 'full', fullTriggers: [file] }, file);
  }
});

test('kök yapılandırma, lockfile, betikler ve workflow değişikliği tam koşu ister', () => {
  for (const file of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'turbo.json',
    '.nvmrc',
    'eslint.config.js',
    'scripts/license/policy.mjs',
    '.github/workflows/packages.yml',
    'tests/README.md',
  ]) {
    assert.equal(classifyChanges([file]).mode, 'full', file);
  }
});

test('listede olmayan her yol tam koşu ister', () => {
  assert.equal(classifyChanges(['yeni-dizin/dosya.ts']).mode, 'full');
  assert.equal(classifyChanges(['docs/api']).mode, 'full');
});

test('Rust tarafı TS kapsamını genişletmez', () => {
  assert.equal(
    classifyChanges(['programs/square-registry/src/lib.rs', 'crates/square-common/src/lib.rs', 'Cargo.lock']).mode,
    'affected',
  );
});

test('main ya da PR dışı olayda her zaman tam koşu', () => {
  assert.deepEqual(decideScope({ event: 'push', baseSha: '', changedFiles: null }), {
    mode: 'full',
    reason: 'push olayı',
    fullTriggers: [],
  });
  assert.equal(decideScope({ event: 'workflow_dispatch', baseSha: '', changedFiles: null }).mode, 'full');
});

test("PR'da değişen dosya listesi alınamazsa tam koşu", () => {
  const r = decideScope({ event: 'pull_request', baseSha: 'abc', changedFiles: null });
  assert.equal(r.mode, 'full');
  assert.match(r.reason, /alınamadı/);
});

test("PR'da taban commit yoksa tam koşu", () => {
  assert.equal(
    decideScope({ event: 'pull_request', baseSha: '', changedFiles: ['packages/sdk/src/a.ts'] }).mode,
    'full',
  );
});

test("PR'da güvenli değişiklik etkilenen paketlerle koşar", () => {
  const r = decideScope({ event: 'pull_request', baseSha: 'abc', changedFiles: ['packages/sdk/src/a.ts'] });
  assert.equal(r.mode, 'affected');
});

test('çıktılar GITHUB_OUTPUT biçiminde ve bayraklar pakete göre', () => {
  const lines = formatOutputs({
    mode: 'affected',
    baseSha: 'abc',
    packages: ['@squaresdk/solana-types', '@squaresdk/solana-db'],
    publishable: ['@squaresdk/solana-types', '@squaresdk/solana-sdk'],
  });
  assert.deepEqual(lines, ['mode=affected', 'base=abc', 'circuit=false', 'smoke=true', 'db=true']);
});

test('devreyi kullanan paket etkilenmişse devre derlenir', () => {
  const lines = formatOutputs({
    mode: 'affected',
    baseSha: 'abc',
    packages: ['@squaresdk/solana-prover'],
    publishable: ['@squaresdk/solana-types'],
  });
  assert.deepEqual(lines, ['mode=affected', 'base=abc', 'circuit=true', 'smoke=false', 'db=false']);
});

test('tam koşuda bütün bayraklar açık', () => {
  assert.deepEqual(formatOutputs({ mode: 'full', baseSha: '', packages: [], publishable: [] }), [
    'mode=full',
    'base=',
    'circuit=true',
    'smoke=true',
    'db=true',
  ]);
});
