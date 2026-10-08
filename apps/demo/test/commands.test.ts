import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { REPO_ROOT } from '@squaresdk/solana-smoke/keys';
import { localnetConfig } from '@squaresdk/solana-smoke/localnet';
import { describe, expect, it } from 'vitest';
import {
  A2A_KEY_ENV,
  agentWalletFor,
  CONFIG_ENV,
  externalAgent,
  loadKeys,
  outcomeLine,
  parseCli,
  prepareAgent,
  requireA2aKey,
  txOptions,
} from '../src/cli.js';
import { loadAgentConfig, parseDemoConfig, requireDemo, requireSeed } from '../src/demo-config.js';
import { demoLocalnetSections, parseDemoLocalnetArgs } from '../src/localnet.js';
import { reportSpec, resolveReportTargets, type ScenarioOutcome } from '../src/scenario.js';
import { screeningEvidenceHash, topUp } from '../src/seed.js';
import { IDS, rawAgentConfig, rawDemoConfig, tempDir } from './helpers.js';

function writeKeyFile(dir: string, name: string): Keypair {
  const keypair = Keypair.generate();
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  return keypair;
}

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
        'http://127.0.0.1:1/x/',
      ]),
    ).toMatchObject({ scenarios: ['a', 'b'], agentUrl: 'http://127.0.0.1:1/x', out: null });
    expect(parseCli(['scenario', '--config', 'c', '--agent-url', 'https://agent.example.org']).agentUrl).toBe(
      'https://agent.example.org',
    );
    expect(parseCli(['seed', '--config', 'c', '--rotate-policy-secret']).rotatePolicySecret).toBe(true);
    expect(parseCli(['seed', '--config', 'c']).rotatePolicySecret).toBe(false);
    expect(parseCli(['agent', '--config', 'c', '--list-claims']).listClaims).toBe(true);
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
    ['ws adresi', ['scenario', '--config', 'c', '--agent-url', 'ws://h'], /--agent-url: agent adresi https olmalı/],
    [
      'yerel olmayan http adresi',
      ['scenario', '--config', 'c', '--agent-url', 'http://agent.example.org'],
      /http yalnızca yerel adreste/,
    ],
    ['seed dışında sır yenileme', ['scenario', '--config', 'c', '--rotate-policy-secret'], /yalnızca seed/],
    ['agent dışında listeleme', ['seed', '--config', 'c', '--list-claims'], /yalnızca agent/],
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
    const options = txOptions({ computeUnitPrice: 1_000, lookupTable });
    expect(options).toEqual({ computeUnitPrice: 1_000n, addressLookupTables: [lookupTable] });
    expect(txOptions({})).toEqual({});
  });
});

describe('komut başına anahtarlar', () => {
  it('yalnızca istenen rollerin anahtarları okunur; eksik zorunlu rol adıyla bildirilir', () => {
    const dir = tempDir();
    const payer = writeKeyFile(dir, 'payer');
    const keys = loadKeys(
      { keys: { payer: join(dir, 'payer.json'), institution: join(dir, 'yok.json') } },
      ['payer'],
      ['screener'],
    );
    expect(Object.keys(keys)).toEqual(['payer']);
    expect(keys.payer!.publicKey.equals(payer.publicKey)).toBe(true);
    expect(() => loadKeys({ keys: { payer: join(dir, 'payer.json') } }, ['payer', 'keeper'])).toThrow(/"keeper"/);
    expect(() => loadKeys({ keys: { payer: join(REPO_ROOT, 'payer.json') } }, ['payer'])).toThrow(/depo içinde/);
  });

  it('agent komutu yalnızca agent anahtarını taşıyan yapılandırmayla çalışır', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'keys'));
    const agent = writeKeyFile(join(dir, 'keys'), 'agent');
    const institution = key().toBase58();
    const path = join(dir, 'agent.json');
    writeFileSync(
      path,
      JSON.stringify(rawAgentConfig({ institutions: [institution], wallet: agent.publicKey.toBase58() })),
    );
    const config = loadAgentConfig(path, {});
    const env = { [A2A_KEY_ENV]: 'k'.repeat(32) };
    const run = prepareAgent(config, { institutions: [], listClaims: false }, env);
    expect(run.signer.publicKey.equals(agent.publicKey)).toBe(true);
    expect(run).toMatchObject({ institutions: [institution], apiKey: 'k'.repeat(32), listClaims: false });
    const override = key().toBase58();
    expect(prepareAgent(config, { institutions: [override], listClaims: true }, env)).toMatchObject({
      institutions: [override],
      listClaims: true,
    });
  });

  it('agent komutu kurum adresi, A2A anahtarı ve tutarlı cüzdan ister', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'keys'));
    writeKeyFile(join(dir, 'keys'), 'agent');
    const path = join(dir, 'agent.json');
    writeFileSync(path, JSON.stringify(rawAgentConfig()));
    const env = { [A2A_KEY_ENV]: 'k'.repeat(32) };
    expect(() => prepareAgent(loadAgentConfig(path, {}), { institutions: [], listClaims: false }, env)).toThrow(
      /demo\.agent\.institutions/,
    );
    expect(() =>
      prepareAgent(loadAgentConfig(path, {}), { institutions: [key().toBase58()], listClaims: false }, {}),
    ).toThrow(A2A_KEY_ENV);
    writeFileSync(path, JSON.stringify(rawAgentConfig({ wallet: key().toBase58() })));
    expect(() =>
      prepareAgent(loadAgentConfig(path, {}), { institutions: [key().toBase58()], listClaims: false }, env),
    ).toThrow(/demo\.agent\.wallet/);
  });

  it('senaryo agent cüzdanını açık anahtardan alır; dış agent için gizli anahtar gerekmez', () => {
    const wallet = key();
    const signer = Keypair.generate();
    const withWallet = parseDemoConfig(rawDemoConfig({ agent: { wallet: wallet.toBase58() } }), '/srv', {});
    expect(agentWalletFor(withWallet, {}).equals(wallet)).toBe(true);
    const plain = parseDemoConfig(rawDemoConfig(), '/srv', {});
    expect(agentWalletFor(plain, { agent: signer }).equals(signer.publicKey)).toBe(true);
    expect(() => agentWalletFor(plain, {})).toThrow(/demo\.agent\.wallet/);
    expect(() => agentWalletFor(withWallet, { agent: signer })).toThrow(/demo\.agent\.wallet/);
  });

  it('dış agent sağlayıcısı aynı uç noktayı verir ve kapatacak bir şeyi yoktur', async () => {
    const provider = externalAgent({ baseUrl: 'https://agent.example.org', apiKey: 'k' });
    const agent = await provider({} as never);
    expect(agent.endpoint.baseUrl).toBe('https://agent.example.org');
    await expect(agent.close()).resolves.toBeUndefined();
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
          proof: { verdict: 'refused', refusalCode: 8, rules: ['payeeBlocked'] } as never,
        }),
      ),
    ).toContain(
      'ispat refused kod 8 (payeeBlocked); teslimat abababababababab…, rapor 3 hesap slot 9; alacak 3880000 ile alıcıya satıldı',
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
    expect(Object.keys(requireSeed(config).policies)).toEqual(['standard', 'blocked-buyer']);
    expect(requireSeed(config).policies['blocked-buyer']!.blockedPayees).toEqual(['buyer']);
    const scenarios = requireDemo(config).scenarios;
    expect(Object.keys(scenarios)).toEqual(['approved', 'approved-claim', 'refused']);
    expect(scenarios['approved-claim']!.claimSale).toBe(true);
    expect(scenarios.refused).toMatchObject({
      expect: 'refused',
      policy: 'blocked-buyer',
      refusalRules: ['payeeBlocked'],
      claimSale: true,
    });
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
    const limits = { maxAccounts: 8, maxSignatures: 10 };
    const spec = reportSpec({ accounts: [mint], signatures: 2, request: 'run/approved', limits });
    expect(spec).toEqual({
      capability: 'solana.account-report',
      accounts: [mint.toBase58()],
      signatures: 2,
      request: 'run/approved',
    });
    expect(() => reportSpec({ accounts: [], signatures: 2, request: 'r', limits })).toThrow(/spec\.accounts/);
    expect(() => reportSpec({ accounts: [mint], signatures: 11, request: 'r', limits })).toThrow(/spec\.signatures/);
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
