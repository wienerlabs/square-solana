// BC-13: `anchor build`'in ürettiği program IDL'lerinin (target/idl/<program>.json) sözleşme IDL'leriyle
// (idl/<program>_contract.json) uyumu. Programların durumu `programs.mjs`'tedir. `address` (yeni program
// kimlikleri BC-09'da) ve `metadata` (ad, sürüm, açıklama) karşılaştırılmaz; geri kalan her şey, doküman
// satırları dahil, sözleşmenin parçasıdır.
//
//   node scripts/ci/idl-conformance.mjs [--built target/idl]
import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROGRAMS, SECTIONS } from './programs.mjs';

const IGNORED_KEYS = new Set(['address', 'metadata']);
const CONTRACT_SUFFIX = '_contract.json';

/** Nesne anahtarları sıralı, dizi sırası korunmuş JSON: aynı içerik aynı metni verir. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** İki değerin ilk ayrıştığı yol (ör. `accounts[1].pda.seeds[2]`); aynıysa null. */
export function firstDifference(a, b, path = '') {
  if (canonical(a) === canonical(b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path || '.'} (uzunluk ${a.length} ≠ ${b.length})`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
      if (d) return d;
    }
  }
  return path || '.';
}

function byName(items, section) {
  const map = new Map();
  for (const item of items ?? []) {
    if (typeof item?.name !== 'string') throw new Error(`${section}: adı olmayan öğe`);
    if (map.has(item.name)) throw new Error(`${section}: '${item.name}' iki kez tanımlı`);
    map.set(item.name, item);
  }
  return map;
}

/**
 * Program IDL'inin sözleşmeden farkları. `pending`: henüz yazılmamış sözleşme öğeleri (programda olmamalı).
 * @returns {{ section: string, name: string, kind: string, detail?: string }[]}
 */
export function compareIdl(program, contract, pending = []) {
  const diffs = [];
  const pendingNames = new Map(SECTIONS.map((s) => [s, new Map()]));
  for (const entry of pending) {
    for (const section of SECTIONS) {
      for (const name of entry[section] ?? []) pendingNames.get(section).set(name, entry.issue);
    }
  }

  const topKeys = new Set([...Object.keys(program), ...Object.keys(contract)]);
  for (const key of [...topKeys].sort()) {
    if (IGNORED_KEYS.has(key) || SECTIONS.includes(key)) continue;
    if (canonical(program[key]) !== canonical(contract[key])) {
      diffs.push({ section: key, name: '', kind: 'different', detail: firstDifference(program[key], contract[key]) });
    }
  }

  for (const section of SECTIONS) {
    const ours = byName(program[section], section);
    const theirs = byName(contract[section], section);
    for (const [name, issue] of pendingNames.get(section)) {
      if (!theirs.has(name)) diffs.push({ section, name, kind: 'pending-unknown', detail: issue });
      else if (ours.has(name)) diffs.push({ section, name, kind: 'pending-present', detail: issue });
    }
    for (const [name, expected] of theirs) {
      if (pendingNames.get(section).has(name)) continue;
      const actual = ours.get(name);
      if (!actual) diffs.push({ section, name, kind: 'missing' });
      else if (canonical(actual) !== canonical(expected)) {
        diffs.push({ section, name, kind: 'different', detail: firstDifference(actual, expected) });
      }
    }
    for (const name of ours.keys()) {
      if (!theirs.has(name)) diffs.push({ section, name, kind: 'extra' });
    }
  }
  return diffs;
}

const KIND_TEXT = {
  missing: 'sözleşmede var, programda yok',
  extra: 'programda var, sözleşmede yok',
  different: 'sözleşmeden farklı',
  'pending-unknown': 'pending listesinde ama sözleşmede yok',
  'pending-present': "pending listesinde ama programda var; programs.mjs'ten çıkarılmalı",
};

export function describeDiff({ section, name, kind, detail }) {
  const where = name ? `${section}.${name}` : section;
  const suffix = detail ? ` (${detail})` : '';
  return `${where}: ${KIND_TEXT[kind]}${suffix}`;
}

/** Anchor.toml'daki [programs.localnet] anahtarları. */
export function anchorPrograms(anchorToml) {
  const names = [];
  let inSection = false;
  for (const raw of anchorToml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inSection = line === '[programs.localnet]';
    else if (inSection) {
      const match = /^([A-Za-z0-9_]+)\s*=/.exec(line);
      if (match) names.push(match[1]);
    }
  }
  return names;
}

function validateEntries(programs) {
  const errors = [];
  for (const p of programs) {
    if (p.status === 'legacy') {
      if (!p.migratedBy) errors.push(`${p.name}: legacy programın migratedBy alanı yok`);
      if (p.pending?.length) errors.push(`${p.name}: legacy programda pending olamaz`);
    } else if (p.status === 'contract') {
      for (const entry of p.pending ?? []) {
        if (!entry.issue) errors.push(`${p.name}: pending girdisinin issue'su yok`);
        for (const key of Object.keys(entry)) {
          if (key !== 'issue' && !SECTIONS.includes(key))
            errors.push(`${p.name}: pending'de bilinmeyen bölüm '${key}'`);
        }
      }
    } else errors.push(`${p.name}: bilinmeyen durum '${p.status}'`);
  }
  return errors;
}

/**
 * @param {{
 *   programs: readonly import('./programs.mjs').Program[],
 *   anchorNames: string[],
 *   contractNames: string[],
 *   readBuilt: (name: string) => object | null,
 *   readContract: (name: string) => object,
 * }} input
 */
export function checkPrograms({ programs, anchorNames, contractNames, readBuilt, readContract }) {
  const errors = validateEntries(programs);
  const notices = [];
  const listed = new Set(programs.map((p) => p.name));
  for (const name of anchorNames) {
    if (!listed.has(name)) errors.push(`${name}: Anchor.toml'da var, scripts/ci/programs.mjs'te yok`);
  }
  for (const p of programs) {
    if (!anchorNames.includes(p.name)) errors.push(`${p.name}: programs.mjs'te var, Anchor.toml'da yok`);
  }
  for (const contract of contractNames) {
    const owners = programs.filter((p) => p.contract === contract);
    if (owners.length !== 1) errors.push(`${contract}: ${owners.length} programa bağlı, tam olarak bir olmalı`);
  }

  for (const p of programs) {
    if (!contractNames.includes(p.contract)) {
      errors.push(`${p.name}: sözleşme IDL'i yok (idl/${p.contract}.json)`);
      continue;
    }
    const built = readBuilt(p.name);
    if (!built) {
      errors.push(`${p.name}: derlenmiş IDL yok (target/idl/${p.name}.json); önce \`anchor build\``);
      continue;
    }
    const diffs = compareIdl(built, readContract(p.contract), p.pending);
    if (p.status === 'contract') {
      errors.push(...diffs.map((d) => `${p.name}: ${describeDiff(d)}`));
      const pendingCount = (p.pending ?? []).reduce(
        (n, e) => n + SECTIONS.reduce((m, s) => m + (e[s]?.length ?? 0), 0),
        0,
      );
      if (diffs.length === 0) {
        notices.push(
          pendingCount === 0
            ? `${p.name}: sözleşmeyle aynı`
            : `${p.name}: sözleşmeyle aynı; ${pendingCount} öğe bekliyor (${p.pending.map((e) => e.issue).join(', ')})`,
        );
      }
    } else if (diffs.length === 0) {
      errors.push(`${p.name}: IDL'i sözleşmeyle aynı ama legacy; programs.mjs'te status: 'contract' yapılmalı`);
    } else {
      notices.push(`${p.name}: legacy, sözleşmeden ${diffs.length} fark; ${p.migratedBy} ile sözleşmeye geçer`);
    }
  }
  return { errors, notices };
}

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const builtFlag = process.argv.indexOf('--built');
  const builtDir = join(root, builtFlag === -1 ? 'target/idl' : process.argv[builtFlag + 1]);
  const contractDir = join(root, 'idl');
  const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
  const contractNames = readdirSync(contractDir)
    .filter((f) => f.endsWith(CONTRACT_SUFFIX))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();

  const { errors, notices } = checkPrograms({
    programs: PROGRAMS,
    anchorNames: anchorPrograms(readFileSync(join(root, 'Anchor.toml'), 'utf8')),
    contractNames,
    readBuilt: (name) => {
      const file = join(builtDir, `${name}.json`);
      return existsSync(file) ? readJson(file) : null;
    },
    readContract: (name) => readJson(join(contractDir, `${name}.json`)),
  });

  for (const line of notices) console.log(`[idl] ${line}`);
  for (const line of errors) console.error(`[idl] ✗ ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [...errors.map((e) => `- ✗ ${e}`), ...notices.map((n) => `- ${n}`)];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Program IDL'leri ve sözleşme\n\n${rows.join('\n')}\n`);
  }
  if (errors.length > 0) {
    console.error(`[idl] ${errors.length} uyumsuzluk. Sözleşme değişikliği: docs/design/program-interface.md §11.`);
    process.exit(1);
  }
  console.log("[idl] ✓ sözleşmeye geçen programların IDL'leri sözleşmeyle aynı");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
