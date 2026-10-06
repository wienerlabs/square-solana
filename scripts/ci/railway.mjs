// BE-05: Railway servis tanımları (`apps/<app>/railway.json`). Her uygulama ayrı bir Railway servisidir
// (ADR 0002); servis kendi Dockerfile'ıyla derlenir ve yalnızca kendisini ya da derlemesine giren bir
// workspace paketini değiştiren commit'te yeniden derlenir (`watchPatterns`). İzlenen yollar uygulamanın
// `package.json`'ındaki `workspace:` bağımlılıklarından geçişli olarak türetilir; elle tutulan liste paket
// eklenince eskir. Sağlık denetimi `/ready`'dir (veritabanı, RPC ve anahtar hazır olmadan trafik gelmez);
// web'in kendi `/healthz` ucu vardır.
//
//   node scripts/ci/railway.mjs           railway.json dosyalarını yazar
//   node scripts/ci/railway.mjs --check   dosyalar türetilenle aynı değilse 1 ile çıkar
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Uygulamaya özel, workspace bağımlılığı olmayan derleme girdileri. */
export const EXTRA_WATCH = Object.freeze({
  // İmaj release devresinin wasm'ını derler, zkey ve manifest'i kopyalar (Dockerfile).
  prover: ['/circuits/payment-compliance/**'],
  // Devre manifest'i web derlemesinin girdisidir (#175 notu).
  web: ['/circuits/payment-compliance/artifacts/manifest.json'],
});

/** Sağlık denetimi yolu; varsayılan `/ready`. */
export const HEALTHCHECK = Object.freeze({ web: '/healthz' });

const ROOT_INPUTS = ['/package.json', '/pnpm-lock.yaml', '/pnpm-workspace.yaml'];

/** Workspace paketleri: ad → depo kökünden dizin. */
export function workspacePackages(root = ROOT) {
  const out = new Map();
  for (const group of ['packages', 'apps', 'tests']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'package.json');
      if (existsSync(file)) out.set(JSON.parse(readFileSync(file, 'utf8')).name, `${group}/${name}`);
    }
  }
  const db = join(root, 'db', 'package.json');
  if (existsSync(db)) out.set(JSON.parse(readFileSync(db, 'utf8')).name, 'db');
  return out;
}

const manifest = (root, dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));

/** `dir`'deki paketin geçişli `workspace:` bağımlılıklarının dizinleri (kendisi hariç), sıralı. */
export function workspaceDeps(root, dir, packages = workspacePackages(root)) {
  const seen = new Set();
  const visit = (current) => {
    const pkg = manifest(root, current);
    // Yalnızca çalışma zamanı ve derleme bağımlılıkları; devDependencies imaja girer (derleme) ama
    // tsconfig gibi ortak ayarlar da build girdisidir, bu yüzden ikisi de izlenir.
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
        const depDir = packages.get(name);
        if (!depDir) throw new Error(`${current}: ${name} workspace paketi bulunamadı`);
        if (!seen.has(depDir)) {
          seen.add(depDir);
          visit(depDir);
        }
      }
    }
  };
  visit(dir);
  seen.delete(dir);
  return [...seen].sort();
}

/** Uygulamanın railway.json içeriği. */
export function railwayConfig(root, app, packages = workspacePackages(root)) {
  const dir = `apps/${app}`;
  const watchPatterns = [
    `/${dir}/**`,
    ...workspaceDeps(root, dir, packages).map((d) => `/${d}/**`),
    ...(EXTRA_WATCH[app] ?? []),
    ...ROOT_INPUTS,
  ];
  return {
    $schema: 'https://railway.com/railway.schema.json',
    build: { builder: 'DOCKERFILE', dockerfilePath: `${dir}/Dockerfile`, watchPatterns },
    deploy: {
      healthcheckPath: HEALTHCHECK[app] ?? '/ready',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
    },
  };
}

/** Dockerfile'ı olan uygulamalar (Railway servisleri). */
export function services(root = ROOT) {
  return readdirSync(join(root, 'apps'))
    .filter((app) => existsSync(join(root, 'apps', app, 'Dockerfile')))
    .sort();
}

const serialize = (config) => `${JSON.stringify(config, null, 2)}\n`;

function main() {
  const check = process.argv.includes('--check');
  const packages = workspacePackages(ROOT);
  const stale = [];
  for (const app of services(ROOT)) {
    const file = join(ROOT, 'apps', app, 'railway.json');
    const expected = serialize(railwayConfig(ROOT, app, packages));
    const actual = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (actual === expected) continue;
    if (check) stale.push(app);
    else writeFileSync(file, expected);
  }
  if (stale.length > 0) {
    process.stderr.write(`[railway] güncel değil: ${stale.join(', ')} (node scripts/ci/railway.mjs)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`[railway] ✓ ${services(ROOT).length} servis\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
