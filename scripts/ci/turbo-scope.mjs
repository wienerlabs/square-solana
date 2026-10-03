// BE-03: PR'da derleme, tip kontrolü ve testlerin kapsamı. Değişiklik yalnızca paket dizinlerinde ve
// testlerin okumadığı belgelerdeyse `turbo --affected`, aksi halde tam koşu; PR dışı olaylarda (main'e
// push, elle tetikleme) her zaman tam koşu. Turbo, paket dışı bir dosyayı yalnızca kök pakete bağlar;
// kök girdiler (lockfile, IDL, API şeması, devre ...) bu yüzden tam koşu ister.
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUBLISHABLE } from './pack-smoke.mjs';

/** Değişmesi `--affected` seçimini eksik bırakmayan yollar. Listede olmayan her yol tam koşu ister. */
const AFFECTED_SAFE = [
  /^packages\/[^/]+\//,
  /^apps\/[^/]+\//,
  /^(packages|apps)\/README\.md$/,
  /^db\//,
  /^\.changeset\//,
  /^docs\/(?!(api|did-aip)(\/|$))[^/]+/,
  /^(README|SECURITY)\.md$/,
  /^(LICENSE|NOTICE)$/,
  /^programs\//,
  /^crates\//,
  /^Cargo\.(toml|lock)$/,
  /^Anchor\.toml$/,
  /^rust-toolchain\.toml$/,
  /^\.cargo\//,
];

/** Testleri derlenmiş release devresini (`circuits/payment-compliance/build`) okuyan paketler. */
const CIRCUIT_CONSUMERS = ['@squaresdk/solana-policy', '@squaresdk/solana-prover'];
const DATABASE_PACKAGE = '@squaresdk/solana-db';

export function classifyChanges(files) {
  const fullTriggers = files.filter((file) => !AFFECTED_SAFE.some((pattern) => pattern.test(file)));
  return { mode: fullTriggers.length === 0 ? 'affected' : 'full', fullTriggers };
}

export function decideScope({ event, baseSha, changedFiles }) {
  if (event !== 'pull_request') return { mode: 'full', reason: `${event} olayı`, fullTriggers: [] };
  if (!baseSha) return { mode: 'full', reason: "PR taban commit'i yok", fullTriggers: [] };
  if (changedFiles === null) return { mode: 'full', reason: 'değişen dosya listesi alınamadı', fullTriggers: [] };
  const { mode, fullTriggers } = classifyChanges(changedFiles);
  return {
    mode,
    reason: mode === 'full' ? 'paket dışı girdi değişti' : 'yalnızca paket dizinleri ve belgeler değişti',
    fullTriggers,
  };
}

export function formatOutputs({ mode, baseSha, packages, publishable }) {
  const touched = (names) => mode === 'full' || names.some((name) => packages.includes(name));
  return [
    `mode=${mode}`,
    `base=${mode === 'affected' ? baseSha : ''}`,
    `circuit=${touched(CIRCUIT_CONSUMERS)}`,
    `smoke=${touched(publishable)}`,
    `db=${touched([DATABASE_PACKAGE])}`,
  ];
}

function changedFilesSince(baseSha) {
  try {
    // Yeniden adlandırmada eski yol da listelenmeli (taşınan bir test girdisi tam koşu ister).
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${baseSha}...HEAD`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function affectedPackages(baseSha) {
  const out = execFileSync('pnpm', ['turbo', 'run', 'build', 'typecheck', 'test', '--affected', '--dry=json'], {
    encoding: 'utf8',
    env: { ...process.env, TURBO_SCM_BASE: baseSha },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.slice(out.indexOf('{'))).packages.filter((name) => name !== '//');
}

export function formatSummary({ scope, packages, lines }) {
  const longestTicks = Math.max(
    0,
    ...[...scope.fullTriggers, ...packages].map((s) => Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length))),
  );
  const fence = '`'.repeat(Math.max(3, longestTicks + 1));
  const block = (items) => [`${fence}text`, ...items, fence];
  return [
    `### Kapsam: ${scope.mode === 'full' ? 'tam koşu' : 'etkilenen paketler'}`,
    `Sebep: ${scope.reason}.`,
    ...(scope.fullTriggers.length ? ['', 'Tam koşu isteyen dosyalar:', ...block(scope.fullTriggers)] : []),
    ...(scope.mode === 'affected' ? ['', 'Etkilenen paketler:', ...block(packages.length ? packages : ['(yok)'])] : []),
    '',
    'Çıktılar:',
    ...block(lines),
  ].join('\n');
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const baseSha = process.env.BASE_SHA ?? '';
  const changedFiles = event === 'pull_request' && baseSha ? changedFilesSince(baseSha) : null;
  let scope = decideScope({ event, baseSha, changedFiles });
  let packages = [];
  if (scope.mode === 'affected') {
    try {
      packages = affectedPackages(baseSha);
    } catch (error) {
      scope = { mode: 'full', reason: `turbo --affected çözülemedi: ${error.message}`, fullTriggers: [] };
    }
  }
  const lines = formatOutputs({ mode: scope.mode, baseSha, packages, publishable: PUBLISHABLE });
  const summary = formatSummary({ scope, packages, lines });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.stdout.write(`${summary}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
