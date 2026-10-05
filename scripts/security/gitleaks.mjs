// BC-13: gitleaks'i depo yapılandırmasıyla (.gitleaks.toml, .gitleaksignore) çalıştırır. CI ve yerel
// pre-commit kancası aynı yolu kullanır; kurulu sürüm scripts/security/gitleaks.env'dekinden eski olamaz.
//
//   node scripts/security/gitleaks.mjs staged    commit'lenecek değişiklikler (.githooks/pre-commit)
//   node scripts/security/gitleaks.mjs history   HEAD'den erişilen bütün git geçmişi (CI, pnpm secrets:scan)
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MODES = Object.freeze(['staged', 'history']);

/** gitleaks.env'deki `GITLEAKS_VERSION`. */
export function pinnedVersion(envText) {
  const match = /^GITLEAKS_VERSION=(\d+\.\d+\.\d+)$/m.exec(envText);
  if (!match) throw new Error('scripts/security/gitleaks.env: GITLEAKS_VERSION bulunamadı');
  return match[1];
}

/** `gitleaks version` çıktısından [major, minor, patch]; tanınmazsa null. */
export function parseVersion(output) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function atLeast(version, minimum) {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/** gitleaks argümanları; yapılandırma ve istisna dosyası açıkça verilir, bulgular maskelenir. */
export function gitleaksArgs(mode) {
  const common = [
    '--config',
    '.gitleaks.toml',
    '--gitleaks-ignore-path',
    '.',
    '--redact',
    '--no-banner',
    '--exit-code',
    '1',
  ];
  if (mode === 'staged') return ['git', '--pre-commit', '--staged', ...common];
  if (mode === 'history') return ['git', ...common];
  throw new Error(`bilinmeyen kip: ${mode} (${MODES.join(' | ')})`);
}

const INSTALL_HINT =
  'gitleaks kurun: macOS `brew install gitleaks`; diğerleri https://github.com/gitleaks/gitleaks/releases';

function main() {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const mode = process.argv[2];
  const minimum = pinnedVersion(readFileSync(new URL('./gitleaks.env', import.meta.url), 'utf8'));

  const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error(`[gitleaks] ✗ gitleaks bulunamadı. ${INSTALL_HINT} (en az ${minimum}).`);
    process.exit(1);
  }
  const version = parseVersion(probe.stdout);
  if (!version || !atLeast(version, parseVersion(minimum))) {
    console.error(`[gitleaks] ✗ gitleaks ${probe.stdout.trim()} eski; en az ${minimum} gerekli. ${INSTALL_HINT}`);
    process.exit(1);
  }

  const result = spawnSync('gitleaks', gitleaksArgs(mode), { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(
      "[gitleaks] ✗ sır bulgusu ya da tarama hatası. Gerçek bir sırsa commit'ten çıkarın ve anahtarı yenileyin;" +
        " yanlış alarmsa gerekçesiyle .gitleaks.toml'a değer bazında istisna yazın.",
    );
  }
  process.exit(result.status ?? 1);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
