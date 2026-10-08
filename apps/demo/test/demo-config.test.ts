import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deliveryUriBytes,
  expectedRefusalCode,
  isReportTarget,
  loadAgentConfig,
  loadDemoConfig,
  parseAgentConfig,
  parseDemoConfig,
  requireDemo,
  requireSeed,
  selectScenarios,
} from '../src/demo-config.js';
import { address, rawAgentConfig, rawDemoConfig, scenario, tempDir, TIMING, USDC_DEVNET } from './helpers.js';

const parse = (raw: unknown) => parseDemoConfig(raw, '/srv/demo', {});

function without(dotted: string): Record<string, unknown> {
  const raw = structuredClone(rawDemoConfig()) as Record<string, unknown>;
  const path = dotted.split('.');
  let node = raw;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  delete node[path.at(-1)!];
  return raw;
}
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
    expect(demo.timing).toEqual(TIMING);
    expect(demo.agent).toMatchObject({
      maxReportAccounts: 8,
      maxReportSignatures: 10,
      retry: { minDelayMs: 1_000, maxDelayMs: 30_000, submitMarginSecs: 30 },
    });
    expect(seed.policies.standard!.timeWindow).toMatchObject({ startHourUtc: 0, endHourUtc: 23 });
    expect(demo.scenarios.approved).toMatchObject({ claimSale: false, amount: 5_000_000n });
    expect(demo.scenarios.approved!.report.signatures).toBe(5);
    expect(demo.scenarios.refused!.refusalRules).toEqual(['perTx']);
    expect(demo.agent.institutions).toEqual([]);
    expect(demo.agent.wallet).toBeUndefined();
  });

  it('agent bölümü kurum adreslerini ve cüzdanı açık anahtar olarak taşır', () => {
    const institution = address();
    const wallet = address();
    const demo = requireDemo(parse(rawDemoConfig({ agent: { institutions: [institution], wallet } })));
    expect(demo.agent.institutions.map((key) => key.toBase58())).toEqual([institution]);
    expect(demo.agent.wallet!.toBase58()).toBe(wallet);
  });

  it('teslimat adresinin bayt uzunluğu normalleştirilmiş URL ile hesaplanır', () => {
    expect(deliveryUriBytes('https://agent.example.org')).toBe(25 + 12 + 64);
    expect(deliveryUriBytes('https://a.org/ğğ')).toBe(13 + '/%C4%9F%C4%9F'.length + 12 + 64);
    expect(
      requireDemo(parse(rawDemoConfig({ agent: { publicUrl: 'https://agent.example.org/ağ' } }))).agent.publicUrl,
    ).toBe('https://agent.example.org/ağ');
  });

  it('ret kuralları beklenen ret koduna çevrilir', () => {
    expect(expectedRefusalCode(['perTx'])).toBe(1);
    expect(expectedRefusalCode(['perTx', 'categoryNotAllowed'])).toBe(17);
    expect(expectedRefusalCode([])).toBe(0);
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
      'agent sınırından fazla rapor hedefi',
      withScenarios({
        a: scenario({ report: { targets: Array.from({ length: 9 }, () => address()), signatures: 1 } }),
      }),
      /maxReportAccounts \(8\)/,
    ],
    [
      'agent sınırından fazla imza',
      withScenarios({ a: scenario({ report: { targets: ['mint'], signatures: 11 } }) }),
      /maxReportSignatures \(10\)/,
    ],
    [
      'negatif imza sayısı',
      withScenarios({ a: scenario({ report: { targets: ['mint'], signatures: -1 } }) }),
      /signatures/,
    ],
    [
      'tekrar deneme aralığı ters',
      rawDemoConfig({ agent: { retry: { minDelayMs: 5_000, maxDelayMs: 1_000, submitMarginSecs: 30 } } }),
      /maxDelayMs/,
    ],
    ['RPC sınırını aşan hesap sayısı', rawDemoConfig({ agent: { maxReportAccounts: 101 } }), /maxReportAccounts/],
    ['RPC sınırını aşan imza sayısı', rawDemoConfig({ agent: { maxReportSignatures: 1_001 } }), /maxReportSignatures/],
    ['sıfır yoklama aralığı', rawDemoConfig({ demo: { timing: { ...TIMING, pollIntervalMs: 0 } } }), /pollIntervalMs/],
    ['senaryosuz demo', withScenarios({}), /en az bir senaryo/],
    [
      'ret kuralsız ret senaryosu',
      withScenarios({ a: scenario({ policy: 'strict', expect: 'refused' }) }),
      /refusalRules/,
    ],
    ['ret kurallı onay senaryosu', withScenarios({ a: scenario({ refusalRules: ['perTx'] }) }), /refusalRules/],
    [
      'bilinmeyen ret kuralı',
      withScenarios({ a: scenario({ policy: 'strict', expect: 'refused', refusalRules: ['tooBig'] }) }),
      /refusalRules/,
    ],
    [
      'tekrar eden ret kuralı',
      withScenarios({ a: scenario({ policy: 'strict', expect: 'refused', refusalRules: ['perTx', 'perTx'] }) }),
      /ret kuralı tekrar/,
    ],
    [
      'tekrar eden kurum',
      rawDemoConfig({ agent: { institutions: [USDC_DEVNET, USDC_DEVNET] } }),
      /kurum adresi tekrar/,
    ],
    ['geçersiz agent cüzdanı', rawDemoConfig({ agent: { wallet: 'x' } }), /wallet/],
    ['http adresi', rawDemoConfig({ agent: { publicUrl: 'http://agent.example.org' } }), /publicUrl/],
    ['uzun adres', rawDemoConfig({ agent: { publicUrl: `https://${'a'.repeat(50)}.org` } }), /128 baytı aşıyor/],
    [
      'kodlanınca uzayan ASCII dışı yol',
      rawDemoConfig({ agent: { publicUrl: `https://a.org/${'ğ'.repeat(8)}` } }),
      /128 baytı aşıyor/,
    ],
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

  it.each([
    'demo.timing',
    'demo.timing.taskTimeoutSecs',
    'demo.timing.claimListingTimeoutSecs',
    'demo.timing.a2aRequestTimeoutSecs',
    'demo.timing.pollIntervalMs',
    'demo.timing.proofDayMarginSecs',
    'demo.agent.maxReportAccounts',
    'demo.agent.maxReportSignatures',
    'demo.agent.retry',
    'demo.agent.retry.minDelayMs',
    'demo.agent.retry.maxDelayMs',
    'demo.agent.retry.submitMarginSecs',
    'demo.agent.price',
    'demo.scenarios.approved.report.signatures',
    'demo.scenarios.approved.amount',
    'demo.scenarios.approved.challengePeriodSecs',
    'demo.scenarios.approved.deadlineSecs',
    'seed.policies.standard.timeWindow',
    'seed.funding.institutionUsdc',
    'seed.funding.buyerUsdc',
    'seed.funding.agentLamports',
    'seed.funding.keeperLamports',
    'seed.screening.minRemainingSecs',
  ])('varsayılanı olmayan %s eksikse yapılandırma reddedilir', (path) => {
    expect(() => parse(without(path))).toThrow(path);
  });

  it('zaman penceresi açıkça null verilirse politika her an geçerlidir', () => {
    const raw = structuredClone(rawDemoConfig());
    raw.seed.policies.standard.timeWindow = null as never;
    expect(requireSeed(parse(raw)).policies.standard!.timeWindow).toBeNull();
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

describe('parseAgentConfig', () => {
  it('yalnızca agent anahtarını taşıyan yapılandırma kabul edilir; yol dosyanın dizinine göre çözülür', () => {
    const config = parseAgentConfig(rawAgentConfig({ institutions: [USDC_DEVNET] }), '/srv/agent', {});
    expect(config.keys).toEqual({ agent: '/srv/agent/keys/agent.json' });
    expect(config.demo.agent.institutions.map((key) => key.toBase58())).toEqual([USDC_DEVNET]);
    expect(config.lookupTable).toBeUndefined();
  });

  it('tam yapılandırmadan yalnızca agent alanlarını alır, diğer anahtar yollarını okumaz', () => {
    const config = parseAgentConfig(rawDemoConfig(), '/srv/demo', {});
    expect(Object.keys(config.keys)).toEqual(['agent']);
    expect(Object.keys(config.demo)).toEqual(['agent']);
    expect(config.lookupTable!.toBase58()).toBe('3cjUqPz9ECuym9w8trGRVUadGbj24Z7BvYALvEfmCCoG');
  });

  it('agent yapılandırmasında maliyet ve zaman sınırları da zorunludur', () => {
    const { retry: _retry, ...withoutRetry } = rawAgentConfig().demo.agent;
    expect(() => parseAgentConfig({ ...rawAgentConfig(), demo: { agent: withoutRetry } }, '/srv', {})).toThrow(
      'demo.agent.retry',
    );
    expect(() => parseAgentConfig(rawAgentConfig({ maxReportAccounts: undefined }), '/srv', {})).toThrow(
      'demo.agent.maxReportAccounts',
    );
  });

  it("agent anahtarı yoksa reddedilir; SMOKE_RPC_URL RPC'yi ezer; dosyadan okunur", () => {
    const { keys: _keys, ...withoutKeys } = rawAgentConfig();
    expect(() => parseAgentConfig({ ...withoutKeys, keys: {} }, '/srv', {})).toThrow(
      /agent yapılandırması geçersiz:\n {2}keys\.agent/,
    );
    expect(parseAgentConfig(rawAgentConfig(), '/srv', { SMOKE_RPC_URL: 'https://rpc.example.org/k' }).rpcUrl).toBe(
      'https://rpc.example.org/k',
    );
    const dir = tempDir();
    const path = join(dir, 'agent.json');
    writeFileSync(path, JSON.stringify(rawAgentConfig()));
    expect(loadAgentConfig(path, {}).keys.agent).toBe(join(dir, 'keys/agent.json'));
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
