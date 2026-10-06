#!/usr/bin/env node
// Komut referansı (BE-30): docs/cli.md komut tablosundan (`COMMANDS`, `GLOBAL_USAGE`) üretilir; referans koddan
// sapamaz. Önce `pnpm build`.
//   node scripts/reference.mjs          docs/cli.md'yi yazar
//   node scripts/reference.mjs --check  belge güncel değilse 1 ile çıkar
import { readFileSync, writeFileSync } from 'node:fs';
import { BIN, COMMANDS, GLOBAL_USAGE } from '../dist/cli.js';
import { DEFAULT_RPC, ENV } from '../dist/config.js';

const OUT = new URL('../../../docs/cli.md', import.meta.url);

/** Ortam değişkenlerinin karşılığı. */
const ENV_MEANING = {
  config: '`--config`',
  cluster: '`--cluster`',
  rpcUrl: '`--rpc-url`',
  keypair: '`--keypair`',
  feePayer: '`--fee-payer`',
  proverUrl: '`--prover-url`',
  proverApiKey: "prover'ın API anahtarı (yalnızca ortamdan)",
};

/** Tablo hücresi: `|` kaçışlanır. */
const cell = (text) => text.replaceAll('|', '\\|');
const option = ([flag, text]) => `| \`${flag}\` | ${cell(text)} |`;

export function reference() {
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  return [
    '# Komut satırı: `squaresdk-solana`',
    '',
    '**Paket:** [`@squaresdk/solana-cli`](../packages/cli/) · **Issue:** BE-30 (#89) · **Karar:** [ADR 0025](decisions/0025-cli-komut-adi-ve-yapilandirma.md)',
    '',
    `> Bu belge \`packages/cli/scripts/reference.mjs\` ile komut tablosundan üretilir; elle değiştirilmez.`,
    '',
    `\`${BIN} <grup> <eylem> [seçenekler]\`. Akışın 8 adımı, uyuşmazlık ve did:aip çözümü. Her komut bir tx kurar`,
    '(SDK akışı ya da program talimatı), rol anahtarıyla imzalar, gönderir ve onayını bekler. Sonuç standart çıktıya,',
    'ilerleme ve hatalar standart hataya yazılır.',
    '',
    '## Yapılandırma',
    '',
    'Öncelik sırası: bayrak, ortam değişkeni, yapılandırma dosyası, varsayılan. Dosya `--config`, `' +
      ENV.config +
      '` ya da',
    'varsa `~/.config/squaresdk-solana/config.json`. Dosyada sır yoktur: anahtarlar `solana-keygen` biçimindeki dosyaların',
    "yollarıdır, prover'ın API anahtarı yalnızca `" + ENV.proverApiKey + '` ortam değişkenindedir.',
    '',
    '```json',
    JSON.stringify(
      {
        cluster: 'devnet',
        rpcUrl: DEFAULT_RPC.devnet,
        commitment: 'confirmed',
        keypair: '~/.config/solana/id.json',
        feePayer: '<ücret ödeyen keypair yolu>',
        computeUnitPrice: 1000,
        lookupTable: '<Square ALT adresi>',
        prover: { url: '<Square API ya da prover servisi>', artifactVersion: '<zkey SHA-256>' },
      },
      null,
      2,
    ),
    '```',
    '',
    '| Ortam değişkeni | Karşılığı |',
    '|---|---|',
    ...Object.entries(ENV).map(([key, name]) => `| \`${name}\` | ${ENV_MEANING[key]} |`),
    '',
    '## Global seçenekler',
    '',
    '| Seçenek | Açıklama |',
    '|---|---|',
    ...GLOBAL_USAGE.map(option),
    '',
    '## Çıktı ve çıkış kodları',
    '',
    "- `--json`: sonuç tek satırlık bir JSON nesnesi; adresler base58, tutarlar ondalık dize, hash'ler hex.",
    '- Hata: standart hataya `hata: <mesaj>`; `--json` ile standart çıktıya `{"error": "<mesaj>"}`. Program hatası',
    '  `<program> programı hatası <kod> <ad>` biçimindedir.',
    '- Çıkış kodu: 0 başarı, 1 hata, 2 kullanım hatası (bilinmeyen komut ya da seçenek).',
    '',
    '## İspat',
    '',
    "`proof bind` ve `policy watch` ispatı uzak prover'dan alır: Square API (`/v1/prove`, `prove` kapsamlı API",
    "anahtarı) ya da prover servisi (`apps/prover`). `artifactVersion` zincirdeki doğrulama anahtarının zkey'idir;",
    'prover başka bir anahtarla çalışıyorsa istek reddedilir. CLI ispatı yerelde üretmez (ADR 0025).',
    '',
    '## Komutlar',
    ...groups.flatMap((group) => [
      '',
      `### ${group}`,
      ...COMMANDS.filter((c) => c.group === group).flatMap((c) => [
        '',
        `#### \`${BIN} ${c.group} ${c.action}${c.positional ? ` <${c.positional}>` : ''}\``,
        '',
        `${c.summary.charAt(0).toUpperCase()}${c.summary.slice(1)}.`,
        ...(c.usage.length > 0 ? ['', '| Seçenek | Açıklama |', '|---|---|', ...c.usage.map(option)] : []),
      ]),
    ]),
    '',
    '## Örnek: 8 adım',
    '',
    'Devnet kabul koşusunun komutları ve imzaları: [deploy/cli-devnet.md](deploy/cli-devnet.md).',
    '',
  ].join('\n');
}

const text = reference();
if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== text) {
    console.error('docs/cli.md güncel değil: node packages/cli/scripts/reference.mjs');
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
