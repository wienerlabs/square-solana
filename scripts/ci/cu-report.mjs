// BC-29: Program testlerinin compute unit raporu. `cu::within` her ölçümü `[cu] <etiket>: <CU> / <bütçe>`
// satırı olarak yazar (tests/programs/src/lib.rs). Bu betik test çıktısındaki satırları etiket başına en
// yüksek değerle Markdown tabloya çevirir. Testler rastgele anahtar kullandığından değerler koşudan koşuya
// PDA bump aramasıyla birkaç bin CU oynar; tablo bir koşunun ölçümüdür, bütçeler testlerde denetlenir.
//
//   cargo test --manifest-path tests/programs/Cargo.toml -- --nocapture | tee cu.log
//   node scripts/ci/cu-report.mjs cu.log
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LINE = /^\[cu\] (.+): (\d+) \/ (\d+)\s*$/;

/** Etiket başına en yüksek ölçüm ve bütçe, etikete göre sıralı. */
export function parse(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line.trim());
    if (!m) continue;
    const [, label, cu, budget] = m;
    const prev = rows.get(label);
    if (!prev || Number(cu) > prev.cu) rows.set(label, { label, cu: Number(cu), budget: Number(budget) });
  }
  return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function table(rows) {
  const lines = ['| Ölçüm | CU | Bütçe | Kullanım |', '|---|---:|---:|---:|'];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${r.cu.toLocaleString('en-US')} | ${r.budget.toLocaleString('en-US')} | ${((r.cu / r.budget) * 100).toFixed(0)}% |`,
    );
  }
  return lines.join('\n');
}

function main() {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('kullanım: node scripts/ci/cu-report.mjs <test çıktısı>\n');
    process.exitCode = 2;
    return;
  }
  const rows = parse(readFileSync(file, 'utf8'));
  if (rows.length === 0) {
    process.stderr.write(`[cu] ${file}: ölçüm satırı yok (testler --nocapture ile mi koştu?)\n`);
    process.exitCode = 1;
    return;
  }
  const out = table(rows);
  process.stdout.write(`${out}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Compute unit\n\n${out}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
