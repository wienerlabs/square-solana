// BC-13: Program araç sürümlerinin tek kaynağı Anchor.toml [toolchain]'dir (ADR 0007). İş akışlarındaki
// `AGAVE_VERSION` / `ANCHOR_VERSION` ve verifiable build imajının etiketi bununla aynı olmalı; biri
// güncellenip diğeri unutulursa CI başka sürümle derler.
//
//   node scripts/ci/toolchain.mjs
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Anchor.toml [toolchain] değerleri. */
export function anchorToolchain(anchorToml) {
  const values = {};
  let inSection = false;
  for (const raw of anchorToml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inSection = line === '[toolchain]';
    else if (inSection) {
      const match = /^([a-z_]+)\s*=\s*"([^"]*)"/.exec(line);
      if (match) values[match[1]] = match[2];
    }
  }
  if (!values.anchor_version || !values.solana_version) {
    throw new Error('Anchor.toml [toolchain]: anchor_version ve solana_version gerekli');
  }
  return { anchor: values.anchor_version, solana: values.solana_version };
}

const PINS = [
  { pattern: /^\s*AGAVE_VERSION:\s*['"]?([^'"\s#]+)/gm, key: 'solana', label: 'AGAVE_VERSION' },
  { pattern: /^\s*ANCHOR_VERSION:\s*['"]?([^'"\s#]+)/gm, key: 'anchor', label: 'ANCHOR_VERSION' },
  { pattern: /solana-verifiable-build:([0-9][^@'"\s]*)/g, key: 'solana', label: 'solana-verifiable-build imajı' },
];

/** Bir iş akışındaki sürüm sabitlemelerinin Anchor.toml'dan farkları. */
export function checkWorkflow(file, text, toolchain) {
  const errors = [];
  let pins = 0;
  for (const { pattern, key, label } of PINS) {
    for (const match of text.matchAll(pattern)) {
      pins += 1;
      if (match[1] !== toolchain[key]) {
        errors.push(`${file}: ${label} ${match[1]}, Anchor.toml [toolchain] ${toolchain[key]}`);
      }
    }
  }
  return { errors, pins };
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const toolchain = anchorToolchain(readFileSync(join(root, 'Anchor.toml'), 'utf8'));
  const dir = join(root, '.github/workflows');
  const errors = [];
  let pins = 0;
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const result = checkWorkflow(`.github/workflows/${file}`, readFileSync(join(dir, file), 'utf8'), toolchain);
    errors.push(...result.errors);
    pins += result.pins;
  }
  for (const e of errors) console.error(`[toolchain] ✗ ${e}`);
  if (errors.length > 0) process.exit(1);
  console.log(
    `[toolchain] ✓ Anchor ${toolchain.anchor}, Agave ${toolchain.solana}; iş akışlarında ${pins} sabitleme aynı`,
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
