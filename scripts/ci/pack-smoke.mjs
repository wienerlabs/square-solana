// BE-03: paket kurulum smoke'u. Yayınlanabilir paketler derlenir ve pack edilir; checkout dışındaki boş bir
// projeye yalnızca bu tarball'larla kurulur (registry'den birinci taraf paket çözülemez) ve her `exports`
// yolu düz Node ile import edilir. Paketler ADR 0001'e göre henüz npm'de değil; liste bu yüzden açık
// tutulur ve her workspace paketi ya listede ya da gerekçeli dışlamadadır.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISHABLE = [
  '@squaresdk/solana-types',
  '@squaresdk/solana-sdk',
  '@squaresdk/solana-identity',
  '@squaresdk/solana-policy',
  '@squaresdk/solana-a2a',
  '@squaresdk/solana-mcp',
];

export const EXCLUDED = {
  '@squaresdk/solana-config': 'yalnızca geliştirme araçlarının ortak ayarları (tsconfig, ESLint, Prettier)',
  '@squaresdk/solana-db': "servislerin iç paketi: tek veritabanının şeması, migration'ları ve istemcisi",
  '@squaresdk/solana-observability':
    'servislerin iç paketi (private): maskeleyen logger, metrikler, health, alarmlar (BE-12)',
  '@squaresdk/solana-hardening':
    'servislerin iç paketi (private): SSRF, idempotency, hız sınırı, RPC failover, imzalı eylemler (BE-13)',
  '@squaresdk/solana-agent-sdk': "kaynaktan taşındı, Square'e uyarlanması BE-19 (#52)",
};

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function checkClassification(found, publishable, excluded) {
  const errors = [];
  for (const name of found) {
    if (!publishable.includes(name) && !(name in excluded)) {
      errors.push(
        `${name} sınıflandırılmamış: scripts/ci/pack-smoke.mjs içinde PUBLISHABLE ya da EXCLUDED listesine ekleyin`,
      );
    }
  }
  for (const name of publishable)
    if (!found.includes(name)) errors.push(`${name} PUBLISHABLE listesinde ama repoda yok`);
  for (const name of Object.keys(excluded))
    if (!found.includes(name)) errors.push(`${name} EXCLUDED listesinde ama repoda yok`);
  return errors;
}

const isSubpathMap = (exportsField) =>
  typeof exportsField === 'object' &&
  exportsField !== null &&
  Object.keys(exportsField).some((key) => key.startsWith('.'));

export function exportSpecifiers(name, exportsField) {
  if (!isSubpathMap(exportsField)) return [name];
  return Object.keys(exportsField)
    .filter((key) => !key.includes('*') && !key.endsWith('.json'))
    .map((key) => (key === '.' ? name : `${name}/${key.slice(2)}`));
}

function collectTargets(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const nested of Object.values(value)) collectTargets(nested, out);
  return out;
}

export function exportTargets(exportsField) {
  return collectTargets(exportsField, []).filter((target) => !target.includes('*'));
}

/** İç içe kurulum: başka bir paketin hoist ettiği kopya, tarball'ın bildirmediği bağımlılığı gizleyemez. */
export function npmInstallArgs() {
  return ['install', '--install-strategy=nested', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'];
}

export function consumerManifest(tarballs) {
  const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]));
  return {
    name: 'square-pack-smoke-consumer',
    private: true,
    type: 'module',
    dependencies,
    overrides: { ...dependencies },
  };
}

export function unresolvedFromLock(lock, names) {
  const entries = lock.packages ?? {};
  const scopes = new Set(names.map((name) => `${name.split('/')[0]}/`));
  const isLocal = (entry) => String(entry.resolved ?? '').startsWith('file:');
  const errors = [];
  for (const name of names) {
    const entry = entries[`node_modules/${name}`];
    if (!entry) errors.push(`${name} lockfile'da yok`);
    else if (!isLocal(entry)) errors.push(`${name} yerel tarball yerine ${entry.resolved} adresinden çözüldü`);
  }
  for (const [key, entry] of Object.entries(entries)) {
    if (names.some((name) => key === `node_modules/${name}`)) continue;
    const installed = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const firstParty = [installed, entry.name ?? ''].some((name) =>
      [...scopes].some((scope) => name.startsWith(scope)),
    );
    if (firstParty && !isLocal(entry)) {
      errors.push(`${key} yerel tarball yerine ${entry.resolved} adresinden çözüldü`);
    }
  }
  return errors;
}

/** Import süreci yalnızca çalışması için gerekenleri alır; CI ortamının geri kalanı paket koduna geçmez. */
export function importEnv(env, specifier) {
  return Object.fromEntries(
    Object.entries({ PATH: env.PATH, HOME: env.HOME, SPEC: specifier }).filter(([, value]) => value !== undefined),
  );
}

/** Apache-2.0 §4: dağıtılan paket lisansı ve NOTICE'i taşır. */
export function missingLegalFiles(exists) {
  return ['LICENSE', 'NOTICE'].filter((name) => !exists(name));
}

function workspacePackageNames() {
  const manifests = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ROOT, 'packages', entry.name, 'package.json'))
    .concat(join(ROOT, 'db', 'package.json'))
    .filter((path) => existsSync(path));
  return manifests.map((path) => JSON.parse(readFileSync(path, 'utf8')).name);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}

function classify() {
  const errors = checkClassification(workspacePackageNames(), PUBLISHABLE, EXCLUDED);
  for (const error of errors) console.error(`HATA: ${error}`);
  return errors.length === 0;
}

function smoke(work) {
  run('pnpm', ['turbo', 'run', 'build', ...PUBLISHABLE.map((name) => `--filter=${name}`)], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const tarballDir = join(work, 'tarballs');
  mkdirSync(tarballDir);
  const tarballs = {};
  for (const name of PUBLISHABLE) {
    const out = run('pnpm', ['--filter', name, 'pack', '--json', '--pack-destination', tarballDir], { cwd: ROOT });
    const packed = JSON.parse(out.slice(out.indexOf('{')));
    tarballs[name] = resolve(tarballDir, packed.filename);
    console.log(`pack: ${name} → ${packed.filename} (${packed.files.length} dosya)`);
  }

  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(consumerManifest(tarballs), null, 2)}\n`);
  run('npm', npmInstallArgs(), { cwd: consumer, stdio: 'inherit' });

  const lockErrors = unresolvedFromLock(
    JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')),
    PUBLISHABLE,
  );
  if (lockErrors.length) {
    for (const error of lockErrors) console.error(`HATA: ${error}`);
    return false;
  }
  const errors = [];
  for (const name of PUBLISHABLE) {
    const installed = join(consumer, 'node_modules', ...name.split('/'));
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    for (const file of missingLegalFiles((name) => existsSync(join(installed, name)))) {
      errors.push(`${name}: tarball'da ${file} yok`);
    }
    for (const target of exportTargets(manifest.exports)) {
      if (!existsSync(join(installed, target))) errors.push(`${name}: exports hedefi tarball'da yok: ${target}`);
    }
    for (const specifier of exportSpecifiers(name, manifest.exports)) {
      try {
        const keys = run(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            'const m = await import(process.env.SPEC); console.log(Object.keys(m).length);',
          ],
          { cwd: consumer, env: importEnv(process.env, specifier), stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim();
        if (Number(keys) === 0) errors.push(`${specifier}: modül hiçbir şey dışa aktarmıyor`);
        else console.log(`import: ${specifier} (${keys} dışa aktarım)`);
      } catch (error) {
        const detail = String(error.stderr ?? error.message)
          .trim()
          .split('\n')
          .slice(0, 6)
          .join(' | ');
        errors.push(`${specifier}: düz Node ile import edilemedi: ${detail}`);
      }
    }
  }
  for (const error of errors) console.error(`HATA: ${error}`);
  return errors.length === 0;
}

function main() {
  if (!classify()) process.exit(1);
  if (process.argv.includes('--classify-only')) {
    console.log(
      `sınıflandırma yeşil: ${PUBLISHABLE.length} yayınlanabilir, ${Object.keys(EXCLUDED).length} dışlanan paket`,
    );
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'square-pack-smoke-'));
  let ok;
  try {
    ok = smoke(work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!ok) process.exit(1);
  console.log(`smoke yeşil: ${PUBLISHABLE.length} paket, Node ${process.version}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
