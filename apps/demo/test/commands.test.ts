import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { REPO_ROOT } from '@squaresdk/solana-smoke/keys';
import { localnetConfig } from '@squaresdk/solana-smoke/localnet';
import { describe, expect, it } from 'vitest';
import { A2A_KEY_ENV, CONFIG_ENV, outcomeLine, parseCli, requireA2aKey, txOptions } from '../src/cli.js';
import { parseDemoConfig, requireDemo, requireSeed } from '../src/demo-config.js';
import { demoLocalnetSections, parseDemoLocalnetArgs } from '../src/localnet.js';
import { reportSpec, resolveReportTargets, type ScenarioOutcome } from '../src/scenario.js';
import { screeningEvidenceHash, topUp } from '../src/seed.js';
import { IDS } from './helpers.js';

const key = () => Keypair.generate().publicKey;

describe('parseCli', () => {
  it('komut, yapılandırma ve komuta özgü bayraklar', () => {
    expect(parseCli(['seed', '--config', 'c.json'])).toMatchObject({ command: 'seed', config: 'c.json' });
    expect(parseCli(['seed'], { [CONFIG_ENV]: 'env.json' }).config).toBe('env.json');
    expect(
      parseCli([
        'scenario',
        '--config',
        'c.json',
        '--scenario',
        'a',
        '--scenario',
        'b',
        '--agent-url',
        'http://h:1/x/',
      ]),
    ).toMatchObject({ scenarios: ['a', 'b'], agentUrl: 'http://h:1/x', out: null });
    const institution = key().toBase58();
    expect(parseCli(['agent', '--config', 'c.json', '--port', '0', '--institution', institution])).toMatchObject({
      port: 0,
      host: '127.0.0.1',
      institutions: [institution],
    });
    expect(parseCli(['agent', '--config', 'c.json']).port).toBe(8787);
  });

  it.each([
    ['komutsuz', [], /kullanım/],
    ['bilinmeyen komut', ['run', '--config', 'c'], /kullanım/],
    ['fazla argüman', ['seed', 'x', '--config', 'c'], /kullanım/],
    ['yapılandırmasız', ['seed'], /yapılandırma gerekli/],
    ['seed ile senaryo', ['seed', '--config', 'c', '--scenario', 'a'], /--scenario yalnızca scenario/],
    ['agent ile çıktı', ['agent', '--config', 'c', '--out', 'o'], /--out yalnızca scenario/],
    ['senaryo ile port', ['scenario', '--config', 'c', '--port', '1'], /--port yalnızca agent/],
    ['geçersiz port', ['agent', '--config', 'c', '--port', '70000'], /--port geçersiz/],
    ['ws adresi', ['scenario', '--config', 'c', '--agent-url', 'ws://h'], /http\(s\)/],
    ['geçersiz kurum', ['agent', '--config', 'c', '--institution', 'x'], /--institution/],
  ])('%s reddedilir', (_, argv, message) => {
    expect(() => parseCli(argv as string[])).toThrow(message);
  });

  it('A2A anahtarı ortamdan okunur', () => {
    expect(requireA2aKey({ [A2A_KEY_ENV]: ' anahtar ' })).toBe('anahtar');
    expect(() => requireA2aKey({})).toThrow(A2A_KEY_ENV);
  });

  it("tx seçenekleri yapılandırmanın öncelik ücretini ve ALT'ını taşır", () => {
    const lookupTable = key();
    const options = txOptions({ config: { computeUnitPrice: 1_000, lookupTable } } as never);
    expect(options).toEqual({ computeUnitPrice: 1_000n, addressLookupTables: [lookupTable] });
    expect(txOptions({ config: {} } as never)).toEqual({});
  });
});

describe('outcomeLine', () => {
  const outcome = (overrides: Partial<ScenarioOutcome>): ScenarioOutcome =>
    ({
      name: 'approved',
      expect: 'approved',
      job: 'JOB',
      delivery: { workHash: 'ab'.repeat(32) },
      report: { accounts: 3, slot: 9 },
      claim: null,
      proof: { verdict: 'compliant', refusalCode: 0, rules: [] },
      settlement: { status: 'released', recipientRole: 'agent', net: '4975000' },
      ...overrides,
    }) as unknown as ScenarioOutcome;

  it('sonucu, ispatı, teslimatı ve alacak satışını tek satırda özetler', () => {
    expect(outcomeLine(outcome({}))).toBe(
      'senaryo approved (approved): job JOB released, agent 4975000; ispat compliant; teslimat abababababababab…, rapor 3 hesap slot 9',
    );
    expect(
      outcomeLine(
        outcome({
          claim: { price: '3880000', buyer: 'B' },
          proof: { verdict: 'refused', refusalCode: 1, rules: ['perTx'] } as never,
        }),
      ),
    ).toContain(
      'ispat refused kod 1 (perTx); teslimat abababababababab…, rapor 3 hesap slot 9; alacak 3880000 ile alıcıya satıldı',
    );
  });
});

describe('localnet koşucusu', () => {
  it('varsayılan portlar ve verilen değerler', () => {
    expect(parseDemoLocalnetArgs([])).toMatchObject({
      deployDir: join(REPO_ROOT, 'target/deploy'),
      rpcPort: 8899,
      faucetPort: 9900,
      gossipPort: 8001,
      dynamicPortRange: '8100-8200',
      scenarios: [],
      out: null,
    });
    expect(
      parseDemoLocalnetArgs([
        '--rpc-port',
        '38899',
        '--faucet-port',
        '39900',
        '--gossip-port',
        '38001',
        '--dynamic-port-range',
        '38100-38200',
        '--scenario',
        'refused',
        '--out',
        'sonuç.json',
      ]),
    ).toMatchObject({
      rpcPort: 38_899,
      faucetPort: 39_900,
      gossipPort: 38_001,
      dynamicPortRange: '38100-38200',
      scenarios: ['refused'],
    });
    expect(() => parseDemoLocalnetArgs(['--rpc-port', '0'])).toThrow(/--rpc-port/);
    expect(() => parseDemoLocalnetArgs(['--dynamic-port-range', '1:2'])).toThrow(/--dynamic-port-range/);
  });

  it('üretilen localnet yapılandırması demo şemasından geçer: iki politika, onay, satış ve ret senaryoları', () => {
    const raw = {
      ...localnetConfig({
        rpcUrl: 'http://127.0.0.1:38899',
        programIds: IDS,
        mint: key(),
        arbitrators: [key(), key(), key()],
        screener: key(),
        mppAuthority: key(),
      }),
      ...demoLocalnetSections({ extraBuyers: [key().toBase58()], escrowProgram: IDS.escrow }),
    };
    const config = parseDemoConfig(raw, '/tmp/demo', {});
    expect(Object.keys(requireSeed(config).policies)).toEqual(['standard', 'strict']);
    const scenarios = requireDemo(config).scenarios;
    expect(Object.keys(scenarios)).toEqual(['approved', 'approved-claim', 'refused']);
    expect(scenarios['approved-claim']!.claimSale).toBe(true);
    expect(scenarios.refused).toMatchObject({ expect: 'refused', policy: 'strict' });
  });
});

describe('senaryo ve seed yardımcıları', () => {
  const wallets = { payer: key(), institution: key(), agent: key(), buyer: key(), keeper: key() };
  const institutionPda = key();
  const mint = key();
  const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), mint.toBuffer()], mint)[0];

  it("rapor hedefleri rollere, token hesaplarına, kuruma ve mint'e çözülür; tekrarlar atılır", () => {
    const raw = key().toBase58();
    const resolved = resolveReportTargets(
      ['institution', 'buyer:usdc', 'mint', 'institution:pda', raw, 'institution', mint.toBase58()],
      { wallets, institutionPda, mint, ata },
    );
    expect(resolved.map((k) => k.toBase58())).toEqual([
      wallets.institution.toBase58(),
      ata(wallets.buyer).toBase58(),
      mint.toBase58(),
      institutionPda.toBase58(),
      raw,
    ]);
  });

  it('spec rapor becerisini, hesapları ve koşu kimliğini taşır; geçersiz spec job açılmadan reddedilir', () => {
    const spec = reportSpec({ accounts: [mint], signatures: 2, request: 'run/approved' });
    expect(spec).toEqual({
      capability: 'solana.account-report',
      accounts: [mint.toBase58()],
      signatures: 2,
      request: 'run/approved',
    });
    expect(() => reportSpec({ accounts: [], signatures: 2, request: 'r' })).toThrow(/spec\.accounts/);
  });

  it("bakiye hedefe tamamlanır; screening kanıt hash'i küme, rol ve cüzdandan türer", () => {
    expect(topUp(5n, 10n)).toBe(5n);
    expect(topUp(10n, 10n)).toBe(0n);
    expect(topUp(11n, 10n)).toBe(0n);
    const wallet = key();
    const hash = screeningEvidenceHash('localnet', 'buyer', wallet);
    expect(hash).toHaveLength(32);
    expect(screeningEvidenceHash('localnet', 'buyer', wallet)).toEqual(hash);
    expect(screeningEvidenceHash('devnet', 'buyer', wallet)).not.toEqual(hash);
    expect(screeningEvidenceHash('localnet', 'agent', wallet)).not.toEqual(hash);
  });
});
