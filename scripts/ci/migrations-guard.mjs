// BE-03: PR'daki migration değişikliklerinin kuralı. main'de bulunan bir migration uygulanmış sayılır:
// değiştirilemez, silinemez, yeniden adlandırılamaz, dizinine dosya eklenemez. Prisma migration'ları dizin
// adına göre sırayla uyguladığı için yeni bir migration main'deki son migration'dan sonra sıralanmalıdır.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'db/prisma/migrations/';
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status, path: paths[0] };
    });
}

export function checkMigrationChanges({ changes, baseMigrations }) {
  const latest = [...baseMigrations].sort().at(-1) ?? '';
  const errors = [];
  for (const { status, path } of changes) {
    if (!path.startsWith(MIGRATIONS_DIR)) continue;
    if (!status.startsWith('A')) {
      errors.push(`${path}: uygulanmış migration değiştirilemez (${status})`);
      continue;
    }
    const dir = path.slice(MIGRATIONS_DIR.length).split('/')[0];
    if (baseMigrations.includes(dir)) {
      errors.push(`${path}: main'de uygulanmış ${dir} dizinine dosya eklenemez`);
    } else if (dir <= latest && !errors.some((error) => error.startsWith(`${dir}:`))) {
      errors.push(
        `${dir}: main'deki son migration'dan (${latest}) önce sıralanıyor; main'i alıp migration'ı yeniden üretin`,
      );
    }
  }
  return errors;
}

function main() {
  const baseSha = process.env.BASE_SHA;
  if (!baseSha) {
    console.error('HATA: BASE_SHA tanımlı değil');
    process.exit(1);
  }
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' });
  const changes = parseNameStatus(git(['diff', '--name-status', `${baseSha}...HEAD`, '--', MIGRATIONS_DIR]));
  const mergeBase = git(['merge-base', baseSha, 'HEAD']).trim();
  const baseMigrations = git(['ls-tree', '--name-only', `${mergeBase}:${MIGRATIONS_DIR.slice(0, -1)}`])
    .split('\n')
    .filter((name) => MIGRATION_NAME.test(name));
  const errors = checkMigrationChanges({ changes, baseMigrations });
  if (errors.length) {
    for (const error of errors) console.error(`HATA: ${error}`);
    process.exit(1);
  }
  console.log(
    `migration kuralları yeşil: ${changes.length} değişiklik, main'deki son migration ${baseMigrations.at(-1)}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
