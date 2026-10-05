// BC-13: Rust biçim ve lint kontrolleri. Kapsam `programs.mjs`'ten gelir:
// - kök workspace'in legacy olmayan üyeleri (sözleşmeye geçen programlar ve crates/*) ile program
//   testleri (tests/programs): `cargo fmt --check` ve `cargo clippy -D warnings`;
// - legacy programlar: `cargo clippy` (uyarılar bildirilir, derleme hatası CI'ı düşürür). Biçimleri
//   sözleşmeye geçerken düzeltilir; şimdi biçimlemek, onları yeniden yazan dallarla çakışırdı.
//
//   node scripts/ci/rust-lint.mjs [fmt|clippy|all]
import { execFileSync, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS } from './programs.mjs';

export const TESTS_MANIFEST = 'tests/programs/Cargo.toml';

/**
 * Workspace üyelerini katı ve legacy olarak ayırır.
 * @param {{ name: string, path: string }[]} members `path`: üyenin repo köküne göre dizini
 */
export function classifyMembers(members, programs = PROGRAMS) {
  const errors = [];
  const byCrate = new Map(programs.map((p) => [p.crate, p]));
  const strict = [];
  const legacy = [];
  for (const { name, path } of members) {
    const program = byCrate.get(name);
    if (path.startsWith('programs/') && !program) {
      errors.push(`${name} (${path}): program crate'i scripts/ci/programs.mjs'te yok`);
      continue;
    }
    (program?.status === 'legacy' ? legacy : strict).push(name);
  }
  for (const p of programs) {
    if (!members.some((m) => m.name === p.crate)) errors.push(`${p.crate}: programs.mjs'te var, workspace'te yok`);
  }
  return { strict: strict.sort(), legacy: legacy.sort(), errors };
}

const packages = (names) => names.flatMap((n) => ['-p', n]);

/** Çalıştırılacak komutlar; her biri `{ label, args }` (cargo argümanları). */
export function plan({ strict, legacy }, step = 'all') {
  const fmt = [
    { label: 'cargo fmt (kök workspace)', args: ['fmt', '--check', ...packages(strict)] },
    { label: 'cargo fmt (program testleri)', args: ['fmt', '--check', '--manifest-path', TESTS_MANIFEST] },
  ];
  const clippy = [
    {
      label: 'cargo clippy -D warnings (kök workspace)',
      args: ['clippy', '--locked', '--all-targets', ...packages(strict), '--', '-D', 'warnings'],
    },
    {
      label: 'cargo clippy -D warnings (program testleri)',
      args: ['clippy', '--locked', '--tests', '--manifest-path', TESTS_MANIFEST, '--', '-D', 'warnings'],
    },
  ];
  if (legacy.length > 0) {
    clippy.push({
      label: `cargo clippy, uyarılar bildirilir (legacy: ${legacy.join(', ')})`,
      args: ['clippy', '--locked', '--all-targets', ...packages(legacy)],
    });
  }
  if (step === 'fmt') return fmt;
  if (step === 'clippy') return clippy;
  if (step === 'all') return [...fmt, ...clippy];
  throw new Error(`bilinmeyen adım: ${step} (fmt | clippy | all)`);
}

function workspaceMembers(root) {
  const meta = JSON.parse(
    execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--locked'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const ids = new Set(meta.workspace_members);
  return meta.packages
    .filter((p) => ids.has(p.id))
    .map((p) => ({ name: p.name, path: relative(root, p.manifest_path).replace(/\/Cargo\.toml$/, '') }));
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const step = process.argv[2] ?? 'all';
  const scope = classifyMembers(workspaceMembers(root));
  if (scope.errors.length > 0) {
    for (const e of scope.errors) console.error(`[rust] ✗ ${e}`);
    process.exit(1);
  }
  console.log(`[rust] katı: ${scope.strict.join(', ')}; legacy: ${scope.legacy.join(', ') || '-'}`);
  const failed = [];
  for (const { label, args } of plan(scope, step)) {
    console.log(`[rust] ${label}: cargo ${args.join(' ')}`);
    const result = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) failed.push(label);
  }
  if (failed.length > 0) {
    console.error(`[rust] ✗ başarısız: ${failed.join('; ')}`);
    if (failed.some((l) => l.startsWith('cargo fmt'))) console.error('[rust] biçim: cargo fmt -p <crate>');
    process.exit(1);
  }
  console.log('[rust] ✓');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
