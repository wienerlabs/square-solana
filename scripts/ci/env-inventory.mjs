// BE-05: Servislerin ortam değişkenleri ve secret envanteri.
// - Uyum: her servisin `.env.example`'ı tam olarak `src/config.ts`'teki zod şemasının anahtarlarını ve
//   servislerde ortak gözlemlenebilirlik değişkenlerini (`@squaresdk/solana-observability`) listeler. Şemada
//   olmayan değişken açılışta doğrulanmaz; örnekte olmayan değişken dağıtımda unutulur.
// - Envanter: `docs/environments.md` bu dosyalardan üretilir; secret sayılan değişkenler işaretlenir ve
//   Railway'de "sealed" değişken olarak tutulur (secret politikası, belgenin başında).
//
//   node scripts/ci/env-inventory.mjs           docs/environments.md'yi yazar
//   node scripts/ci/env-inventory.mjs --check   uyumsuzluk ya da eski belge varsa 1 ile çıkar
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DOC = join(ROOT, 'docs', 'environments.md');

/** Değeri sızarsa yetki ya da fon kaybettiren değişkenler. */
const SECRET =
  /(SECRET|PASSWORD|TOKEN$|DATABASE_URL|KEYPAIR(_BASE58)?$|API_KEY$|ACCESS_KEY_ID$|_KEYS$|ALERT_WEBHOOK_URL$|RPC_URLS?$)/;
/** Adı benzese de secret olmayanlar: hash'ler, dosya yolları, anahtar kimlikleri, herkese açık anahtarlar. */
const NOT_SECRET = /(_SHA256$|_PATH$|_ACTIVE_KEY$|_ACTIVE_KEY_ID$|PUBLISHABLE_KEY$)/;

export const isSecret = (name) => SECRET.test(name) && !NOT_SECRET.test(name);

/** `z.object({ ... })` içindeki büyük harfli anahtarlar (`KEY:` satırları). */
export function schemaKeys(source) {
  return [...source.matchAll(/^\s+([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]);
}

/** `.env.example`: değişkenler ve her birinin üstündeki yorum satırı (bölüm başlıkları hariç). */
export function parseEnvExample(text) {
  const vars = [];
  let comment = [];
  let section = '';
  for (const line of text.split('\n')) {
    const heading = /^#\s*---\s*(.+?)\s*---\s*$/.exec(line);
    if (heading) {
      section = heading[1];
      comment = [];
    } else if (line.startsWith('#')) {
      comment.push(line.replace(/^#\s?/, ''));
    } else if (/^[A-Z][A-Z0-9_]{2,}=/.test(line)) {
      vars.push({ name: line.slice(0, line.indexOf('=')), section, note: comment.join(' ') });
      comment = [];
    } else if (line.trim() === '') {
      comment = [];
    }
  }
  return vars;
}

/** Ortak gözlemlenebilirlik değişkenleri. */
export function observabilityKeys(root = ROOT) {
  return schemaKeys(readFileSync(join(root, 'packages', 'observability', 'src', 'config.ts'), 'utf8'));
}

/** `src/config.ts` ve `.env.example`'ı olan uygulamalar. */
export function services(root = ROOT) {
  return readdirSync(join(root, 'apps'))
    .filter((app) => existsSync(join(root, 'apps', app, 'src', 'config.ts')))
    .sort();
}

/** Servisin şema ile örnek arasındaki farkları. */
export function mismatches(root, app, shared) {
  const configFile = join(root, 'apps', app, 'src', 'config.ts');
  const exampleFile = join(root, 'apps', app, '.env.example');
  if (!existsSync(exampleFile)) return [`${app}: .env.example yok`];
  const expected = new Set([...schemaKeys(readFileSync(configFile, 'utf8')), ...shared]);
  const actual = new Set(parseEnvExample(readFileSync(exampleFile, 'utf8')).map((v) => v.name));
  return [
    ...[...expected].filter((k) => !actual.has(k)).map((k) => `${app}: ${k} şemada var, .env.example'da yok`),
    ...[...actual].filter((k) => !expected.has(k)).map((k) => `${app}: ${k} .env.example'da var, şemada yok`),
  ];
}

const HEADER = `# Ortamlar, değişkenler ve secret'lar

**Issue:** BE-05 (#19) · **Karar:** [ADR 0002](decisions/0002-web-hosting-railway.md) (web ve servisler Railway'de)

Bu belgenin tabloları \`node scripts/ci/env-inventory.mjs\` ile üretilir ve CI'da denetlenir; elle düzenlenmez.

## Ortamlar

| Ortam | Railway environment | Küme | Not |
|---|---|---|---|
| PR preview | PR Environments (PR başına, kapanınca silinir) | devnet | yalnızca web ve API; secret'lar staging'den, ayrı anahtarlarla |
| Devnet | \`staging\` | devnet | bütün servisler; Square'in kalıcı ortamı ([runbook](runbooks/upgrade.md), BC-30). Mainnet ortamı yok ([ADR 0027](decisions/0027-yalnizca-devnet.md)) |

Her servis bir Railway servisidir; derleme ve sağlık denetimi \`apps/<servis>/railway.json\`'dadır
(\`node scripts/ci/railway.mjs\` üretir, CI denetler).

## Secret politikası

1. **Repoda secret yok.** \`.env*\` dosyaları \`.gitignore\`'dadır (\`.env.example\` hariç, değerleri boştur);
   gitleaks pre-commit kancası ve CI keypair dosyalarını, 64 baytlık gizli anahtarları ve bilinen sağlayıcı
   anahtarlarını yakalar ([docs/ci.md](ci.md#sır-taraması)).
2. **Secret'lar Railway'de "sealed" değişkendir.** Değer bir kez yazılır, arayüzde ve API'de okunamaz; yalnızca
   servisin süreci görür. Aşağıda **secret** işaretli her değişken böyle tutulur; diğerleri normal değişkendir.
3. **Ortam başına ayrı değer.** PR ortamları devnet ortamının (\`staging\`) secret'larını değil kendi kısıtlı
   anahtarlarını kullanır; iki ortam aynı veritabanını ya da RPC sağlayıcı anahtarını paylaşmaz.
4. **İmzalayan anahtarlar** (keeper, screener authority, fee payer sponsoru, MPP authority, x402 fee payer)
   yalnızca kendi rolünü taşır ve ücret için gereken SOL'den fazlasını tutmaz. Program upgrade authority'si ve
   config admin'i hiçbir servis anahtarı değildir: 2-of-3 Squads vault'udur ([ADR 0008](decisions/0008-upgrade-authority-2-of-3-squads.md)).
5. **Rotasyon:** sızma şüphesinde aynı gün; düzenli olarak 90 günde bir. Zincirde yetkisi olan anahtarın
   rotasyonu önce zincirdeki yetkiyi (ör. registry \`screener_authority\`) yeni anahtara taşır, sonra eski
   değeri siler. Servisler açılışta anahtarın zincirdeki yetkiyle eşleştiğini denetler.
6. **Hash'lenmiş değerler** (\`*_SHA256\`) secret değildir: servis yalnızca izinli anahtarların özetini tutar.
7. **Açılışta doğrulama:** her servis ortamı \`src/config.ts\`'teki zod şemasıyla okur; eksik ya da geçersiz
   değerde süreç başlamaz. Bu belgedeki listeler şemalarla ve \`.env.example\` dosyalarıyla CI'da eşlenir.
`;

export function renderDoc(root = ROOT) {
  const lines = [HEADER, '## Servisler', ''];
  for (const app of services(root)) {
    const vars = parseEnvExample(readFileSync(join(root, 'apps', app, '.env.example'), 'utf8'));
    const secrets = vars.filter((v) => isSecret(v.name)).length;
    lines.push(`### ${app}`, '', `\`apps/${app}/.env.example\` · ${vars.length} değişken, ${secrets} secret`, '');
    lines.push('| Değişken | Bölüm | Secret | Not |', '|---|---|---|---|');
    for (const v of vars) {
      const note = v.note.replaceAll('|', '\\|');
      lines.push(`| \`${v.name}\` | ${v.section} | ${isSecret(v.name) ? '**secret**' : ''} | ${note} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const shared = observabilityKeys(ROOT);
  const problems = services(ROOT).flatMap((app) => mismatches(ROOT, app, shared));
  const doc = renderDoc(ROOT);
  if (check) {
    if (!existsSync(DOC) || readFileSync(DOC, 'utf8') !== doc) {
      problems.push('docs/environments.md güncel değil (node scripts/ci/env-inventory.mjs)');
    }
  } else if (problems.length === 0) {
    writeFileSync(DOC, doc);
  }
  for (const p of problems) process.stderr.write(`[env] ✗ ${p}\n`);
  if (problems.length > 0) process.exitCode = 1;
  else process.stdout.write(`[env] ✓ ${services(ROOT).length} servis, şemalar ve örnekler uyumlu\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
