// BC-29: Program testlerinin kapsam raporu. Programlar SBF olarak LiteSVM'de koştuğu için satır kapsamı
// ölçülemez; kapsam sözleşmenin yüzeyine göre ölçülür:
// - talimat: talimatın builder'ı (`<program>::instruction::<Ad>`) testlerde kullanılıyor;
// - ret dalı: talimatın kaynağında (ve kullandığı crate modüllerinde) geçen hata kodlarından en az biri
//   testlerde beklenen hata olarak denetleniyor (`<Program>Error::<Ad>`);
// - hata kodu: sözleşmedeki her kod testlerde beklenen hata olarak denetleniyor. Testle tetiklenemeyen
//   savunma kodları gerekçesiyle `UNREACHABLE`'da listelenir ve paydadan düşer.
// `GATED` programları için üç oranın her biri en az `THRESHOLD` olmalı; diğerleri yalnızca raporlanır.
//
//   node scripts/ci/program-coverage.mjs [--tests tests/programs/tests]
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS } from './programs.mjs';

export const THRESHOLD = 0.8;
/** Kapsam kapısı uygulanan programlar (BC-29: escrow). */
export const GATED = Object.freeze(['square_escrow']);

/** Testle tetiklenemeyen savunma kodları ve gerekçeleri. */
export const UNREACHABLE = Object.freeze({
  square_escrow: {
    MathOverflow: 'u64 tutarlar ve i64 zamanlar üzerinde savunma; sınır değerler hesaplanabilir bakiye ve saat dışı',
    ClaimListingMismatch:
      'listeleme `["claim", job]` seed kısıtıyla bağlı; başka işin listelemesi ConstraintSeeds ile düşer (substitution.rs)',
  },
});

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `snake_case` → `PascalCase` (Anchor'ın talimat struct adı). */
export const pascal = (name) =>
  name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

/** Programın hata enum'unun adı: crate'in `errors.rs`'indeki `pub enum <Ad>`. */
export function errorEnum(crateDir) {
  const match = /pub enum (\w+Error)\b/.exec(readFileSync(join(crateDir, 'src', 'errors.rs'), 'utf8'));
  if (!match) throw new Error(`${crateDir}: hata enum'u bulunamadı`);
  return match[1];
}

/** Dizindeki bütün `.rs` dosyalarının birleşik içeriği. */
export function readSources(dir) {
  let text = '';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) text += readSources(path);
    else if (entry.endsWith('.rs')) text += `${readFileSync(path, 'utf8')}\n`;
  }
  return text;
}

/** Kaynakta geçen `<Enum>::<Ad>` hata adları. */
export function referencedErrors(source, enumName) {
  return new Set([...source.matchAll(new RegExp(`${enumName}::(\\w+)`, 'g'))].map((m) => m[1]));
}

/**
 * Talimatın üretebileceği hata kodları: talimat dosyası ve içe aktardığı crate modülleri (`crate::<mod>`).
 * Talimat dosyası yoksa (ör. birden çok talimatın paylaştığı struct) boş küme döner.
 */
export function instructionErrors(crateDir, instruction, enumName) {
  const file = join(crateDir, 'src', 'instructions', `${instruction}.rs`);
  if (!existsSync(file)) return new Set();
  const source = readFileSync(file, 'utf8');
  let text = source;
  for (const [, mod] of source.matchAll(/crate::(\w+)/g)) {
    const modFile = join(crateDir, 'src', `${mod}.rs`);
    if (mod !== 'errors' && existsSync(modFile)) text += readFileSync(modFile, 'utf8');
  }
  return referencedErrors(text, enumName);
}

/**
 * Bir programın kapsamı.
 * @returns {{ program: string, instructions: {name: string, used: boolean, negative: boolean|null}[],
 *   errors: {name: string, asserted: boolean, unreachable?: string}[] }}
 */
export function programCoverage({ name, crate }, contract, tests) {
  const crateDir = join(ROOT, 'programs', crate);
  const enumName = errorEnum(crateDir);
  const asserted = referencedErrors(tests, enumName);
  const pending = new Set((PROGRAMS.find((p) => p.name === name)?.pending ?? []).flatMap((p) => p.instructions ?? []));
  const instructions = contract.instructions
    .filter((ix) => !pending.has(ix.name))
    .map((ix) => {
      const errors = instructionErrors(crateDir, ix.name, enumName);
      return {
        name: ix.name,
        used: tests.includes(`${name}::instruction::${pascal(ix.name)}`),
        negative: errors.size === 0 ? null : [...errors].some((e) => asserted.has(e)),
      };
    });
  const unreachable = UNREACHABLE[name] ?? {};
  const errors = contract.errors.map((e) => ({
    name: e.name,
    asserted: asserted.has(e.name),
    ...(unreachable[e.name] ? { unreachable: unreachable[e.name] } : {}),
  }));
  return { program: name, instructions, errors };
}

const ratio = (hit, total) => (total === 0 ? 1 : hit / total);

/** Üç oran: talimat, ret dalı (hata üretebilen talimatlar), hata kodu (ulaşılabilir kodlar). */
export function ratios(coverage) {
  const withErrors = coverage.instructions.filter((i) => i.negative !== null);
  const reachable = coverage.errors.filter((e) => !e.unreachable);
  return {
    instructions: ratio(coverage.instructions.filter((i) => i.used).length, coverage.instructions.length),
    negative: ratio(withErrors.filter((i) => i.negative).length, withErrors.length),
    errors: ratio(reachable.filter((e) => e.asserted).length, reachable.length),
  };
}

const pct = (r) => `${(r * 100).toFixed(1)}%`;

export function report(coverages) {
  const lines = ['| Program | Talimat | Ret dalı | Hata kodu | Eksik |', '|---|---|---|---|---|'];
  for (const c of coverages) {
    const r = ratios(c);
    const missing = [
      ...c.instructions.filter((i) => !i.used).map((i) => `ix ${i.name}`),
      ...c.instructions.filter((i) => i.negative === false).map((i) => `ret ${i.name}`),
      ...c.errors.filter((e) => !e.asserted && !e.unreachable).map((e) => e.name),
    ];
    lines.push(
      `| ${c.program}${GATED.includes(c.program) ? ' (kapı)' : ''} | ${pct(r.instructions)} | ${pct(r.negative)} | ${pct(r.errors)} | ${missing.join(', ') || '—'} |`,
    );
  }
  return lines.join('\n');
}

/** Kapı uygulanan programlarda eşiğin altındaki oranlar. */
export function failures(coverages, threshold = THRESHOLD) {
  const out = [];
  for (const c of coverages.filter((x) => GATED.includes(x.program))) {
    for (const [kind, value] of Object.entries(ratios(c))) {
      if (value < threshold) out.push(`${c.program}: ${kind} ${pct(value)} < ${pct(threshold)}`);
    }
  }
  return out;
}

function main() {
  const testsArg = process.argv.indexOf('--tests');
  const testsDir = testsArg > 0 ? process.argv[testsArg + 1] : join(ROOT, 'tests', 'programs', 'tests');
  const tests = readSources(testsDir);
  const coverages = PROGRAMS.map((p) =>
    programCoverage(p, JSON.parse(readFileSync(join(ROOT, 'idl', `${p.contract}.json`), 'utf8')), tests),
  );
  const table = report(coverages);
  process.stdout.write(`${table}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Program kapsamı\n\n${table}\n`);
  const failed = failures(coverages);
  for (const f of failed) process.stderr.write(`[coverage] ✗ ${f}\n`);
  if (failed.length > 0) process.exitCode = 1;
  else process.stdout.write(`[coverage] ✓ ${GATED.join(', ')} her oranda en az ${pct(THRESHOLD)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
