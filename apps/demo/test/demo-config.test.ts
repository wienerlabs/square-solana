import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isReportTarget,
  loadDemoConfig,
  parseDemoConfig,
  requireDemo,
  requireSeed,
  selectScenarios,
} from '../src/demo-config.js';
import { address, rawDemoConfig, scenario, tempDir, USDC_DEVNET } from './helpers.js';

const parse = (raw: unknown) => parseDemoConfig(raw, '/srv/demo', {});
const withScenarios = (scenarios: Record<string, unknown>) => rawDemoConfig({ demo: { scenarios } });

describe('parseDemoConfig', () => {
  it("küme yapılandırması smoke'unkiyle, seed ve demo bölümleri tiplenmiş ve yolları çözülmüş döner", () => {
    const config = parse(rawDemoConfig());
    expect(config.cluster.settlementMint.toBase58()).toBe(USDC_DEVNET);
    expect(config.cluster.keys.agent).toBe('/srv/demo/keys/agent.json');
    const seed = requireSeed(config);
    expect(seed.policySecret).toBe('/srv/demo/state/policy-secret');
    expect(seed.output).toBe('/srv/demo/state/seed-devnet.json');
    expect(seed.policies.strict!.maxPerTx).toBe(1_000_000n);
    expect(seed.funding.agentLamports).toBe(100_000_000n);
    expect(seed.extraBuyers).toEqual([]);
    const demo = requireDemo(config);
    expect(demo.agent.publicUrl).toBe('https://agent.example.org');
    expect(demo.agent.price).toBe(1_000_000n);
    expect(demo.taskTimeoutSecs).toBe(180);
    expect(demo.scenarios.approved).toMatchObject({ claimSale: false, amount: 5_000_000n });
    expect(demo.scenarios.approved!.report.signatures).toBe(5);
  });

  it('mutlak yollar korunur, ek alıcılar PublicKey olur', () => {
    const extra = address();
    const config = parse(rawDemoConfig({ seed: { policySecret: '/secure/secret', extraBuyers: [extra] } }));
    expect(requireSeed(config).policySecret).toBe('/secure/secret');
    expect(requireSeed(config).extraBuyers[0]!.toBase58()).toBe(extra);
  });

  it('bölümler isteğe bağlıdır; isteyen komut adıyla hata verir', () => {
    const { seed: _seed, demo: _demo, ...bare } = rawDemoConfig();
    const config = parse(bare);
    expect(config.seed).toBeUndefined();
    expect(() => requireSeed(config)).toThrow(/"seed" bölümü yok/);
    expect(() => requireDemo(config)).toThrow(/"demo" bölümü yok/);
  });

  it('seed olmadan senaryonun politikası denetlenmez', () => {
    const { seed: _seed, ...withoutSeed } = rawDemoConfig();
    expect(requireDemo(parse(withoutSeed)).scenarios.refused!.policy).toBe('strict');
  });

  it.each([
    ['bilinmeyen politika', withScenarios({ a: scenario({ policy: 'missing' }) }), /seed\.policies içinde yok/],
    ['fiyatın altında tutar', withScenarios({ a: scenario({ amount: '999999' }) }), /fiyatından/],
    [
      'listelemesiz alacak satışı',
      rawDemoConfig({
        agent: { autoListClaimBps: undefined },
        demo: { scenarios: { a: scenario({ claimSale: true }) } },
      }),
      /autoListClaimBps/,
    ],
    [
      'ret senaryosunda satış',
      withScenarios({ a: scenario({ expect: 'refused', claimSale: true }) }),
      /ret senaryosunda/,
    ],
    ['deadline challenge süresinden kısa', withScenarios({ a: scenario({ deadlineSecs: 60 }) }), /deadline/],
    ['bilinmeyen hedef', withScenarios({ a: scenario({ report: { targets: ['treasury'] } }) }), /rol/],
    [
      'çok fazla hedef',
      withScenarios({ a: scenario({ report: { targets: Array.from({ length: 9 }, () => address()) } }) }),
      /targets/,
    ],
    [
      'imza sayısı sınır dışı',
      withScenarios({ a: scenario({ report: { targets: ['mint'], signatures: 11 } }) }),
      /signatures/,
    ],
    ['senaryosuz demo', withScenarios({}), /en az bir senaryo/],
    ['http adresi', rawDemoConfig({ agent: { publicUrl: 'http://agent.example.org' } }), /publicUrl/],
    ['uzun adres', rawDemoConfig({ agent: { publicUrl: `https://${'a'.repeat(50)}.org` } }), /52 karakter/],
    ['sorgulu adres', rawDemoConfig({ agent: { publicUrl: 'https://agent.example.org/?x=1' } }), /sorgu/],
    ['geçersiz agent kimliği', rawDemoConfig({ agent: { agentId: 'demo agent' } }), /agentId/],
    ['sıfır fiyat', rawDemoConfig({ agent: { price: 0 } }), /sıfır/],
    ['büyük harfli politika adı', rawDemoConfig({ seed: { policies: { Standard: {} } } }), /policies/],
    ['politikasız seed', rawDemoConfig({ seed: { policies: {} } }), /1 ile 8 politika/],
    [
      'tekrar eden kategori',
      rawDemoConfig({
        seed: { policies: { standard: { maxPerTx: 1, maxDaily: 1, dailyCeiling: 1, categories: ['a', 'a'] } } },
      }),
      /kategori tekrar/,
    ],
    ['uzun kurum adı', rawDemoConfig({ seed: { institutionName: 'ş'.repeat(33) } }), /64 bayt/],
    ['geçersiz ek alıcı', rawDemoConfig({ seed: { extraBuyers: ['x'] } }), /extraBuyers/],
    ['geçersiz küme alanı', rawDemoConfig({ root: { settlementMint: 'x' } }), /küme yapılandırması geçersiz/],
  ])('%s reddedilir', (_, raw, message) => {
    expect(() => parse(raw)).toThrow(message);
  });

  it('bölümün tipi yanlışsa hata bölümün adıyla bildirilir', () => {
    expect(() => parseDemoConfig({ ...rawDemoConfig(), seed: 'x' }, '/srv', {})).toThrow(
      /demo yapılandırması geçersiz:\n {2}seed/,
    );
  });
});

describe('loadDemoConfig', () => {
  it('dosyadan okur; göreli yollar dosyanın dizinine göre, bozuk JSON adıyla raporlanır', () => {
    const dir = tempDir();
    const path = join(dir, 'devnet.json');
    writeFileSync(path, JSON.stringify(rawDemoConfig()));
    expect(requireSeed(loadDemoConfig(path, {})).policySecret).toBe(join(dir, 'state/policy-secret'));
    writeFileSync(path, '{');
    expect(() => loadDemoConfig(path, {})).toThrow(/okunamadı/);
  });

  it("SMOKE_RPC_URL küme RPC'sini ezer", () => {
    const dir = tempDir();
    const path = join(dir, 'devnet.json');
    writeFileSync(path, JSON.stringify(rawDemoConfig()));
    expect(loadDemoConfig(path, { SMOKE_RPC_URL: 'https://rpc.example.org/k' }).cluster.rpcUrl).toBe(
      'https://rpc.example.org/k',
    );
  });
});

describe('selectScenarios ve isReportTarget', () => {
  const demo = requireDemo(parse(rawDemoConfig()));

  it('ad verilmezse yapılandırmadaki sırayla hepsi; verilirse yalnızca onlar', () => {
    expect(selectScenarios(demo, []).map(([name]) => name)).toEqual(['approved', 'refused']);
    expect(selectScenarios(demo, ['refused']).map(([name]) => name)).toEqual(['refused']);
    expect(() => selectScenarios(demo, ['missing'])).toThrow(/bilinmeyen senaryo: missing \(approved, refused\)/);
  });

  it.each([
    ['institution', true],
    ['buyer:usdc', true],
    ['mint', true],
    ['institution:pda', true],
    [USDC_DEVNET, true],
    ['agent:pda', false],
    ['treasury', false],
    ['', false],
  ])('%s hedef mi: %s', (target, expected) => {
    expect(isReportTarget(target)).toBe(expected);
  });
});
