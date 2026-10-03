#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COPIES = ['LICENSE', 'NOTICE'];
const ROOT_FILES = ['pnpm-workspace.yaml', ...COPIES];

const statOf = (path) => lstatSync(path, { throwIfNoEntry: false });
const isFile = (path) => statOf(path)?.isFile() === true;
const listed = (manifest, name) => Array.isArray(manifest.files) && manifest.files.includes(name);

function governs(manifest) {
  if (manifest.license !== 'Apache-2.0') return false;
  return manifest.private !== true || COPIES.some((name) => listed(manifest, name));
}

function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  } catch (err) {
    throw new Error(`${dir}/package.json: ${err.message}`, { cause: err });
  }
}

function rootCopies() {
  for (const name of ROOT_FILES) {
    if (!isFile(join(ROOT, name))) throw new Error(`kökte ${name} yok (${ROOT}); komut repo kökünden çalıştırılır`);
  }
  return new Map(COPIES.map((name) => [name, readFileSync(join(ROOT, name))]));
}

function governedPackages() {
  return readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isFile(join(ROOT, 'packages', entry.name, 'package.json')))
    .map((entry) => `packages/${entry.name}`)
    .sort()
    .map((dir) => ({ dir, manifest: readManifest(dir) }))
    .filter(({ manifest }) => governs(manifest));
}

function copyProblem(dir, name, root) {
  const path = join(ROOT, dir, name);
  const stat = statOf(path);
  if (!stat) return 'yok';
  if (!stat.isFile()) return 'düz dosya değil (sembolik bağ paketlenmez)';
  return readFileSync(path).equals(root.get(name)) ? null : `kökteki ${name} ile aynı değil`;
}

function problemsOf({ dir, manifest }, root) {
  return COPIES.flatMap((name) => {
    const problems = [];
    if (!listed(manifest, name)) problems.push(`${dir}/package.json: "files" ${name} içermiyor`);
    const problem = copyProblem(dir, name, root);
    if (problem) problems.push(`${dir}/${name} ${problem}`);
    return problems;
  });
}

function check(packages, root) {
  const problems = packages.flatMap((pkg) => problemsOf(pkg, root));
  if (problems.length > 0) {
    console.error('\n[license] ❌ paketlerdeki LICENSE / NOTICE kopyaları:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      "  kopyalar için `pnpm license:write` çalıştırıp sonucu commit'leyin; package.json alanları elle düzeltilir",
    );
    return 1;
  }
  const dirs = packages.map(({ dir }) => dir).join(', ');
  console.log(`[license] ✓ ${packages.length} paketin LICENSE ve NOTICE kopyaları kökle aynı${dirs && `: ${dirs}`}`);
  return 0;
}

function write(packages, root) {
  for (const { dir } of packages) {
    for (const name of COPIES) {
      if (!copyProblem(dir, name, root)) continue;
      const path = join(ROOT, dir, name);
      if (statOf(path)?.isSymbolicLink()) unlinkSync(path);
      writeFileSync(path, root.get(name));
      console.log(`[license] ${dir}/${name} kökten yazıldı`);
    }
  }
  return check(packages, root);
}

function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (mode !== '--check' && mode !== '--write')) {
    console.error('kullanım: pack-files.mjs --check | --write');
    return 2;
  }
  const root = rootCopies();
  const packages = governedPackages();
  return mode === '--write' ? write(packages, root) : check(packages, root);
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`[license] ${err.message}`);
  process.exitCode = 2;
}
