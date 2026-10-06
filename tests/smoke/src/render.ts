// Markdown çıktıları (saf; I/O yok): Squads'a girilecek talimatlar, init kayıt satırları (BC-30) ve smoke
// raporu (BC-31). Girdiler zincirden okunmuş düz değerlerdir; biçim `docs/deploy/` kayıtlarınınkidir.
import type { TxRecord } from './chain.js';

export type Section = 'init' | 'hazırlık' | 'akış' | 'ispat-ret' | 'ispat-yok' | 'fiat';

/** Kayıttaki bir tx ve ait olduğu bölüm. */
export interface SectionedTx extends TxRecord {
  section: Section;
}

/** Squads "Transaction builder"ına ya da SDK'nın `vault_transaction_create`'ine girilecek talimat. */
export interface SquadsInstruction {
  program: string;
  instruction: string;
  programId: string;
  accounts: readonly { name: string; pubkey: string; signer: boolean; writable: boolean }[];
  dataBase64: string;
  /** Talimatın argümanları, onaylayan üyelerin okuyacağı biçimde. */
  args: readonly (readonly [string, string])[];
}

export interface ProgramRecord {
  name: string;
  id: string;
  executable: boolean;
  upgradeAuthority: string | null;
  /** "yerel anahtar", "Squads vault" ya da "yok". */
  authorityKind: string;
  deploySlot: number;
  executableHash: string;
}

export interface InitRecord {
  cluster: string;
  rpcHost: string;
  generatedAt: string;
  commit: string;
  programs: readonly ProgramRecord[];
  /** Config hesapları: başlık → (alan, değer) satırları; kurulmamışsa null. */
  configs: readonly { title: string; address: string; rows: readonly (readonly [string, string])[] | null }[];
  lookupTable: { address: string; authority: string; entries: readonly (readonly [string, string])[] } | null;
  transactions: readonly SectionedTx[];
  pendingSquads: readonly SquadsInstruction[];
}

export interface SmokeReport {
  cluster: string;
  rpcHost: string;
  startedAt: string;
  finishedAt: string;
  commit: string;
  runId: string;
  /** Raporun başına yazılan uyarılar (ör. "localnet; devnet raporu değildir"). */
  banner: readonly string[];
  parameters: readonly (readonly [string, string])[];
  roles: readonly (readonly [string, string])[];
  transactions: readonly SectionedTx[];
  checks: readonly { section: Section; text: string }[];
  proofs: readonly { section: Section; job: string; verdict: string; refusalCode: number; provingMs: number }[];
  /** Explorer bağlantısının kümesi (devnet, testnet, mainnet-beta); yoksa bağlantı verilmez. */
  explorerCluster: string | null;
  init: InitRecord | null;
}

const escapeCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

const code = (value: string) => `\`${value}\``;
/** Binlik ayırıcılı tamsayı (docs/design/tx-budget.md'deki gibi ince boşluk değil, düz boşluk). */
export const grouped = (value: number | bigint) => value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** RPC adresinin yalnızca sunucusu: yol ve sorgu API anahtarı taşıyabilir, kayda yazılmaz. */
export const rpcHost = (url: string) => new URL(url).host;

export function squadsInstructionMarkdown(ix: SquadsInstruction, index: number): string {
  return [
    `### ${index}. \`${ix.program}\` · \`${ix.instruction}\``,
    '',
    `- **Program:** ${code(ix.programId)}`,
    ...ix.args.map(([name, value]) => `- **${name}:** ${code(value)}`),
    '',
    table(
      ['#', 'Hesap', 'Adres', 'İmzacı', 'Yazılabilir'],
      ix.accounts.map((a, i) => [
        String(i),
        a.name,
        code(a.pubkey),
        a.signer ? 'evet' : 'hayır',
        a.writable ? 'evet' : 'hayır',
      ]),
    ),
    '',
    'Veri (base64):',
    '',
    '```text',
    ix.dataBase64,
    '```',
  ].join('\n');
}

function signatureCell(signature: string, explorerCluster: string | null): string {
  if (!explorerCluster) return code(signature);
  const query = explorerCluster === 'mainnet-beta' ? '' : `?cluster=${explorerCluster}`;
  return `[${code(signature)}](https://explorer.solana.com/tx/${signature}${query})`;
}

export function txTable(records: readonly SectionedTx[], explorerCluster: string | null): string {
  return table(
    ['Adım', 'Tx', 'İmza', 'CU', 'CU sınırı', 'Ücret (lamport)', 'Boyut (bayt)', 'Sonuç'],
    records.map((r) => [
      r.step,
      r.label,
      signatureCell(r.signature, explorerCluster),
      grouped(r.computeUnits),
      r.computeUnitLimit === null ? 'varsayılan' : grouped(r.computeUnitLimit),
      grouped(r.feeLamports),
      String(r.sizeBytes),
      r.error ? `beklenen ret: ${code(`${r.error.program}::${r.error.name}`)} (${r.error.code})` : 'başarılı',
    ]),
  );
}

export function initRecordMarkdown(record: InitRecord): string {
  const out: string[] = [
    `Küme: **${record.cluster}** · RPC: ${code(record.rpcHost)} · tarih (UTC): ${record.generatedAt} · commit: ${code(record.commit)}`,
    '',
    '### Programlar',
    '',
    table(
      [
        'Program',
        'Kimlik',
        'Executable',
        'Upgrade authority',
        'Deploy slotu',
        'Executable hash (solana-verify yöntemi)',
      ],
      record.programs.map((p) => [
        code(p.name),
        code(p.id),
        p.executable ? 'evet' : 'HAYIR',
        p.upgradeAuthority ? `${code(p.upgradeAuthority)} (${p.authorityKind})` : 'yok',
        String(p.deploySlot),
        code(p.executableHash),
      ]),
    ),
  ];
  for (const config of record.configs) {
    out.push('', `### ${config.title}`, '', `Hesap: ${code(config.address)}`, '');
    out.push(
      config.rows
        ? table(
            ['Alan', 'Değer'],
            config.rows.map(([field, value]) => [field, code(value)]),
          )
        : 'Kurulmadı: talimatı Squads işlemi olarak bekliyor (aşağıda).',
    );
  }
  out.push('', '### Square ALT', '');
  if (record.lookupTable) {
    out.push(
      `Adres: ${code(record.lookupTable.address)} · authority: ${code(record.lookupTable.authority)}`,
      '',
      table(
        ['#', 'Girdi', 'Adres'],
        record.lookupTable.entries.map(([entry, address], i) => [String(i), code(entry), code(address)]),
      ),
    );
  } else {
    out.push('Kurulmadı.');
  }
  if (record.transactions.length > 0) {
    out.push('', '### Init işlemleri', '', txTable(record.transactions, null));
  }
  if (record.pendingSquads.length > 0) {
    out.push(
      '',
      "### Squads'a girilecek talimatlar",
      '',
      "Upgrade authority Squads vault'udur: aşağıdaki talimatlar gönderilmedi. Her biri bir vault işlemidir",
      "(`vault_transaction_create` → iki onay → `vault_transaction_execute`); imzacı ve ödeyici vault'tur",
      '([runbook adım 5](../runbooks/upgrade.md#5-configlerin-kurulması-vault-imzasıyla)). Yürütüldükten sonra',
      "`init` yeniden çalıştırılır; config'ler zincirden okunup kayda yazılır.",
      ...record.pendingSquads.flatMap((ix, i) => ['', squadsInstructionMarkdown(ix, i + 1)]),
    );
  }
  return out.join('\n');
}

const SECTION_TITLES: Readonly<Record<Section, string>> = {
  init: 'Init',
  hazırlık: 'Hazırlık',
  akış: '8 adım',
  'ispat-ret': 'Varyant: ispat-ret (kesin ret → iade)',
  'ispat-yok': 'Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)',
  fiat: 'Varyant: fiat (Stripe MPP attestation, BC-37)',
};

export function smokeReportMarkdown(report: SmokeReport): string {
  const sections: Section[] = ['hazırlık', 'akış', 'ispat-ret', 'ispat-yok', 'fiat'];
  const all = report.transactions.filter((r) => r.section !== 'init');
  const totalCu = all.reduce((sum, r) => sum + r.computeUnits, 0);
  const totalFee = all.reduce((sum, r) => sum + r.feeLamports, 0);
  const out: string[] = [
    `# Smoke raporu: ${report.cluster}`,
    '',
    ...report.banner.map((line) => `> ${line}`),
    ...(report.banner.length > 0 ? [''] : []),
    '**Issue:** BC-31 (#43) · **Üreten:** [`tests/smoke`](../../tests/smoke/)',
    '',
    table(
      ['Alan', 'Değer'],
      [
        ['Küme', report.cluster],
        ['RPC', code(report.rpcHost)],
        ['Başlangıç (UTC)', report.startedAt],
        ['Bitiş (UTC)', report.finishedAt],
        ['Commit', code(report.commit)],
        ['Koşu', code(report.runId)],
        ...report.parameters.map(([k, v]) => [k, v] as [string, string]),
      ],
    ),
    '',
    '## Roller',
    '',
    table(
      ['Rol', 'Adres'],
      report.roles.map(([role, key]) => [role, code(key)]),
    ),
    '',
    '## Özet',
    '',
    table(
      ['Bölüm', 'Tx', 'CU', 'Ücret (lamport)'],
      [
        ...sections
          .map((section) => [section, all.filter((r) => r.section === section)] as const)
          .filter(([, rows]) => rows.length > 0)
          .map(([section, rows]) => [
            SECTION_TITLES[section],
            String(rows.length),
            grouped(rows.reduce((s, r) => s + r.computeUnits, 0)),
            grouped(rows.reduce((s, r) => s + r.feeLamports, 0)),
          ]),
        ['**Toplam**', String(all.length), grouped(totalCu), grouped(totalFee)],
      ],
    ),
  ];
  for (const section of sections) {
    const rows = all.filter((r) => r.section === section);
    const checks = report.checks.filter((c) => c.section === section);
    const proofs = report.proofs.filter((p) => p.section === section);
    if (rows.length === 0 && checks.length === 0) continue;
    out.push('', `## ${SECTION_TITLES[section]}`, '', txTable(rows, report.explorerCluster));
    if (proofs.length > 0) {
      out.push(
        '',
        table(
          ['İspat', 'Karar', 'Ret kodu', 'İspat süresi (ms)'],
          proofs.map((p) => [code(p.job), p.verdict, String(p.refusalCode), grouped(p.provingMs)]),
        ),
      );
    }
    if (checks.length > 0) out.push('', 'Zincirden doğrulananlar:', '', ...checks.map((c) => `- ${c.text}`));
  }
  if (report.init) {
    out.push('', '## Init kaydı (BC-30)', '', initRecordMarkdown(report.init));
  }
  return `${out.join('\n')}\n`;
}
