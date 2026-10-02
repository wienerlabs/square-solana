#!/usr/bin/env node
// Paket adı kuralı (BE-01, docs/decisions/0001): repodaki her package.json adı `@squaresdk/solana-` ile başlar;
// `square` ve `@square/*` (Square Inc.) reddedilir; apps/* altındakiler `private: true` olmalıdır.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const SKIP = new Set(['node_modules', 'dist', 'target', '.turbo', '.git', 'build']);
const PREFIX = '@squaresdk/solana-';

function* packageJsons(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* packageJsons(path);
    else if (entry === 'package.json') yield path;
  }
}

const problems = [];
let count = 0;
for (const file of packageJsons(root)) {
  count += 1;
  const rel = relative(root, file);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const name = typeof pkg.name === 'string' ? pkg.name : '';
  if (name === 'square' || name.startsWith('@square/')) problems.push(`${rel}: "${name}" Square Inc.'e ait bir ad`);
  else if (!name.startsWith(PREFIX)) problems.push(`${rel}: "${name}" "${PREFIX}" ile başlamıyor`);
  if (rel.startsWith('apps/') && pkg.private !== true) problems.push(`${rel}: apps/* paketleri "private": true olmalı`);
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log(`✓ ${count} package.json: adlar ${PREFIX} ile başlıyor`);
