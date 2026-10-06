import { describe, expect, it } from 'vitest';
import {
  grouped,
  initRecordMarkdown,
  rpcHost,
  smokeReportMarkdown,
  squadsInstructionMarkdown,
  table,
  txTable,
  type InitRecord,
  type SectionedTx,
  type SmokeReport,
  type SquadsInstruction,
} from '../src/render.js';

const tx = (overrides: Partial<SectionedTx>): SectionedTx => ({
  step: '1',
  label: '`setPolicy`',
  signature: 'SIG1',
  slot: 10,
  computeUnits: 18_778,
  computeUnitLimit: 40_000,
  feeLamports: 10_040,
  sizeBytes: 500,
  error: null,
  section: 'akış',
  ...overrides,
});

const squads: SquadsInstruction = {
  program: 'square_registry',
  instruction: 'init_registry_config',
  programId: 'Prog',
  accounts: [
    { name: 'admin', pubkey: 'Vault', signer: true, writable: true },
    { name: 'config', pubkey: 'Cfg', signer: false, writable: true },
  ],
  dataBase64: 'AAEC',
  args: [['screening_ttl_secs', '86400']],
};

const init: InitRecord = {
  cluster: 'devnet',
  rpcHost: 'api.devnet.solana.com',
  generatedAt: '2026-10-06T00:00:00Z',
  commit: 'abc',
  programs: [
    {
      name: 'square_escrow',
      id: 'Esc',
      executable: true,
      upgradeAuthority: 'Vault',
      authorityKind: 'Squads vault',
      deploySlot: 5,
      executableHash: 'ff',
    },
    {
      name: 'square_policy',
      id: 'Pol',
      executable: false,
      upgradeAuthority: null,
      authorityKind: 'yok',
      deploySlot: 6,
      executableHash: 'ee',
    },
  ],
  configs: [
    { title: 'RegistryConfig', address: 'Cfg', rows: null },
    { title: 'EscrowConfig', address: 'Esc', rows: [['admin', 'Vault']] },
  ],
  lookupTable: null,
  transactions: [],
  pendingSquads: [squads],
};

describe('Markdown yardımcıları', () => {
  it('tablo hücrelerinde | ve satır sonu kaçırılır; sayılar gruplanır', () => {
    expect(table(['a', 'b'], [['x|y', 'z\nw']])).toBe('| a | b |\n| --- | --- |\n| x\\|y | z w |');
    expect(grouped(1_234_567)).toBe('1 234 567');
    expect(grouped(12n)).toBe('12');
  });

  it("RPC'nin yalnızca sunucusu yazılır (yol ve sorgu API anahtarı taşıyabilir)", () => {
    expect(rpcHost('https://devnet.helius-rpc.com/?api-key=secret')).toBe('devnet.helius-rpc.com');
    expect(rpcHost('http://127.0.0.1:48899')).toBe('127.0.0.1:48899');
  });

  it('Squads talimatı: program, argümanlar, hesaplar ve base64 veri', () => {
    const md = squadsInstructionMarkdown(squads, 1);
    expect(md).toContain('### 1. `square_registry` · `init_registry_config`');
    expect(md).toContain('- **screening_ttl_secs:** `86400`');
    expect(md).toContain('| 0 | admin | `Vault` | evet | evet |');
    expect(md).toContain('| 1 | config | `Cfg` | hayır | evet |');
    expect(md).toContain('```text\nAAEC\n```');
  });

  it('tx tablosu: explorer bağlantısı, varsayılan CU sınırı ve beklenen ret', () => {
    const rows = [
      tx({}),
      tx({ computeUnitLimit: null, error: { program: 'escrow', code: 6039, name: 'proofRequired' } }),
    ];
    const local = txTable(rows, null);
    expect(local).toContain('| 1 | `setPolicy` | `SIG1` | 18 778 | 40 000 | 10 040 | 500 | başarılı |');
    expect(local).toContain('varsayılan');
    expect(local).toContain('beklenen ret: `escrow::proofRequired` (6039)');
    expect(txTable(rows, 'devnet')).toContain('(https://explorer.solana.com/tx/SIG1?cluster=devnet)');
    expect(txTable(rows, 'mainnet-beta')).toContain('(https://explorer.solana.com/tx/SIG1)');
  });
});

describe('init kaydı', () => {
  it('programlar, kurulmamış config, ALT yok ve bekleyen Squads talimatları', () => {
    const md = initRecordMarkdown(init);
    expect(md).toContain('| `square_escrow` | `Esc` | evet | `Vault` (Squads vault) | 5 | `ff` |');
    expect(md).toContain('| `square_policy` | `Pol` | HAYIR | yok | 6 | `ee` |');
    expect(md).toContain('Kurulmadı: talimatı Squads işlemi olarak bekliyor');
    expect(md).toContain('| admin | `Vault` |');
    expect(md).toMatch(/### Square ALT\n\nKurulmadı\./);
    expect(md).toContain("### Squads'a girilecek talimatlar");
    expect(md).not.toContain('### Init işlemleri');
  });

  it('gönderilen init işlemleri ve ALT girdileri', () => {
    const md = initRecordMarkdown({
      ...init,
      pendingSquads: [],
      transactions: [tx({ section: 'init', step: 'init', label: '`init_config`' })],
      lookupTable: { address: 'Alt', authority: 'Payer', entries: [['program:escrow', 'Esc']] },
    });
    expect(md).toContain('Adres: `Alt` · authority: `Payer`');
    expect(md).toContain('| 0 | `program:escrow` | `Esc` |');
    expect(md).toContain('### Init işlemleri');
    expect(md).not.toContain("Squads'a girilecek");
  });
});

describe('smoke raporu', () => {
  const report: SmokeReport = {
    cluster: 'localnet',
    rpcHost: '127.0.0.1:48899',
    startedAt: 's',
    finishedAt: 'f',
    commit: 'abc',
    runId: 'run',
    banner: ['**Küme: localnet.** Devnet raporu değildir.'],
    parameters: [['İş tutarı', '25']],
    roles: [['keeper', 'Keeper']],
    transactions: [
      tx({ section: 'init', step: 'init' }),
      tx({ section: 'hazırlık', step: '0', computeUnits: 100, feeLamports: 5_000 }),
      tx({ section: 'akış' }),
      tx({ section: 'ispat-yok', step: '6 + 8', error: { program: 'escrow', code: 6039, name: 'proofRequired' } }),
    ],
    checks: [
      { section: 'akış', text: 'alıcıya ödendi' },
      { section: 'ispat-yok', text: 'escrow bekliyor' },
    ],
    proofs: [{ section: 'akış', job: 'Job', verdict: 'compliant', refusalCode: 0, provingMs: 1_500 }],
    explorerCluster: null,
    init,
  };

  it('uyarı, özet (init hariç toplam), bölümler, ispatlar, doğrulamalar ve init kaydı', () => {
    const md = smokeReportMarkdown(report);
    expect(md.startsWith('# Smoke raporu: localnet\n\n> **Küme: localnet.** Devnet raporu değildir.\n')).toBe(true);
    expect(md).toContain('| Hazırlık | 1 | 100 | 5 000 |');
    expect(md).toContain('| **Toplam** | 3 | 37 656 | 25 080 |');
    expect(md).toContain('## 8 adım');
    expect(md).not.toContain('## Varyant: ispat-ret');
    expect(md).toContain('## Varyant: ispat-yok (escrow bekler, ispat bağlanınca ödenir)');
    expect(md).toContain('| `Job` | compliant | 0 | 1 500 |');
    expect(md).toContain('- alıcıya ödendi');
    expect(md).toContain('## Init kaydı (BC-30)');
    expect(md.endsWith('\n')).toBe(true);
    const plain = smokeReportMarkdown({ ...report, banner: [], init: null });
    expect(plain.startsWith('# Smoke raporu: localnet\n\n**Issue:**')).toBe(true);
    expect(plain).not.toContain('Init kaydı');
  });
});
