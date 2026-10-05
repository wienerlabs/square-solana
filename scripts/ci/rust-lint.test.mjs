import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROGRAMS } from './programs.mjs';
import { TESTS_MANIFEST, classifyMembers, plan } from './rust-lint.mjs';

const members = [
  { name: 'square-common', path: 'crates/square-common' },
  { name: 'square-policy', path: 'programs/square-policy' },
  { name: 'square-registry', path: 'programs/square-registry' },
  { name: 'verifier', path: 'programs/square-verifier' },
  { name: 'square-escrow', path: 'programs/square-escrow' },
];

test('legacy programlar katı kapsamın dışında, crates/* katı', () => {
  const scope = classifyMembers(members, PROGRAMS);
  assert.deepEqual(scope.errors, []);
  const legacy = PROGRAMS.filter((p) => p.status === 'legacy').map((p) => p.crate);
  assert.deepEqual(scope.legacy, [...legacy].sort());
  assert.deepEqual(
    scope.strict,
    members
      .map((m) => m.name)
      .filter((name) => !legacy.includes(name))
      .sort(),
  );
  assert.ok(scope.strict.includes('square-common'));
});

test("listede olmayan program crate'i ve workspace'te olmayan program hata", () => {
  const scope = classifyMembers([...members, { name: 'square-new', path: 'programs/square-new' }], PROGRAMS);
  assert.deepEqual(scope.errors, ["square-new (programs/square-new): program crate'i scripts/ci/programs.mjs'te yok"]);
  const missing = classifyMembers(members.slice(0, 4), PROGRAMS);
  assert.deepEqual(missing.errors, ["square-escrow: programs.mjs'te var, workspace'te yok"]);
});

test('komutlar: katı kapsam -D warnings ile, legacy uyarıyla', () => {
  const scope = { strict: ['a', 'b'], legacy: ['c'] };
  assert.deepEqual(
    plan(scope, 'fmt').map((c) => c.args),
    [
      ['fmt', '--check', '-p', 'a', '-p', 'b'],
      ['fmt', '--check', '--manifest-path', TESTS_MANIFEST],
    ],
  );
  const clippy = plan(scope, 'clippy').map((c) => c.args);
  assert.deepEqual(clippy[0], ['clippy', '--locked', '--all-targets', '-p', 'a', '-p', 'b', '--', '-D', 'warnings']);
  assert.deepEqual(clippy[1].slice(-3), ['--', '-D', 'warnings']);
  assert.deepEqual(clippy[2], ['clippy', '--locked', '--all-targets', '-p', 'c']);
  assert.equal(plan(scope).length, 5);
  assert.equal(plan({ strict: ['a'], legacy: [] }, 'clippy').length, 2);
  assert.throws(() => plan(scope, 'test'), /bilinmeyen adım/);
});
