import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadClusterConfig, parseClusterConfig, requireSection } from '../src/config.js';
import { rawConfig, tempDir, USDC_DEVNET } from './helpers.js';

const parse = (raw: unknown, env: NodeJS.ProcessEnv = {}) => parseClusterConfig(raw, '/srv/smoke', env);
const withInit = (escrow: Record<string, unknown>) => {
  const base = rawConfig();
  return { ...base, init: { ...base.init, escrow: { ...base.init.escrow, ...escrow } } };
};
const withParams = (params: Record<string, unknown>) =>
  withInit({ params: { ...rawConfig().init.escrow.params, ...params } });
const withSmoke = (smoke: Record<string, unknown>) => ({ ...rawConfig(), smoke: { ...rawConfig().smoke, ...smoke } });

describe('parseClusterConfig', () => {
  it('geçerli yapılandırma: adresler PublicKey, u64 bigint, göreli anahtar yolları dizine göre', () => {
    const config = parse(rawConfig({ keys: { payer: 'keys/payer.json', admin: '/abs/admin.json' } }));
    expect(config.settlementMint.toBase58()).toBe(USDC_DEVNET);
    expect(config.keys.payer).toBe('/srv/smoke/keys/payer.json');
    expect(config.keys.admin).toBe('/abs/admin.json');
    expect(config.init!.escrow.params.maxChallengePeriod).toBe(2_592_000n);
    expect(config.smoke!.jobAmount).toBe(1_000_000n);
    expect(config.smoke!.claimPrice).toBe(900_000n);
  });

  it("SMOKE_RPC_URL dosyadaki RPC'yi ezer", () => {
    expect(parse(rawConfig(), { SMOKE_RPC_URL: ' https://rpc.example.org/key ' }).rpcUrl).toBe(
      'https://rpc.example.org/key',
    );
    expect(parse(rawConfig(), { SMOKE_RPC_URL: '' }).rpcUrl).toBe('https://api.devnet.solana.com');
  });

  it.each([
    ['geçersiz adres', rawConfig({ settlementMint: 'not-a-key' }), /settlementMint/],
    ['büyük harfli küme adı', rawConfig({ cluster: 'Devnet' }), /cluster/],
    ['http olmayan RPC', rawConfig({ rpcUrl: 'ws://x' }), /rpcUrl/],
    ['tekrar eden arbitrator', withInit({ arbitrators: [USDC_DEVNET, USDC_DEVNET] }), /tekrar/],
    ['tek arbitrator', withInit({ arbitrators: [USDC_DEVNET], threshold: 2 }), /arbitrators/],
    ['eşik N üstü', withInit({ threshold: 4 }), /2 ≤ M ≤ N/],
    ['eşik 1', withInit({ threshold: 1 }), /threshold/],
    ['boş anahtar arbitrator', withInit({ arbitrators: ['11111111111111111111111111111111', USDC_DEVNET] }), /boş/],
    ['keeper ücreti %1 üstü', withParams({ keeperFeeBps: 101 }), /keeperFeeBps/],
    ['min challenge 0', withParams({ minChallengePeriod: 0 }), /challenge/],
    ['min > max', withParams({ minChallengePeriod: 10, maxChallengePeriod: 5 }), /challenge/],
    ['max i64 üstü', withParams({ maxChallengePeriod: (2n ** 63n).toString() }), /challenge/],
    ['u64 üstü', withParams({ minBondAbsolute: (2n ** 64n).toString() }), /u64/],
    ['dispute süresi 0', withParams({ disputeTimeoutSecs: 0 }), /disputeTimeoutSecs/],
    ['negatif ispat süresi', withParams({ proofTimeoutSecs: -1 }), /proofTimeoutSecs/],
    ['fiyat ≥ tutar', withSmoke({ claimPrice: 1_000_000 }), /fiyat/],
    ['fiyat 0', withSmoke({ claimPrice: 0 }), /fiyat/],
    ['tutar 0', withSmoke({ jobAmount: 0, claimPrice: 0 }), /tutar sıfır/],
    ['deadline ≤ challenge', withSmoke({ deadlineSecs: 60 }), /deadline/],
  ])('%s reddedilir', (_, raw, message) => {
    expect(() => parse(raw)).toThrow(message);
  });

  it('kök tipi yanlışsa hata yolu "(kök)"', () => {
    expect(() => parse('x')).toThrow(/\(kök\)/);
  });
});

describe('loadClusterConfig ve requireSection', () => {
  it('dosyadan okur; anahtar yolları dosyanın dizinine göre', () => {
    const dir = tempDir();
    const path = join(dir, 'devnet.json');
    writeFileSync(path, JSON.stringify(rawConfig()));
    expect(loadClusterConfig(path, {}).keys.payer).toBe(join(dir, 'keys/payer.json'));
    writeFileSync(path, '{');
    expect(() => loadClusterConfig(path, {})).toThrow(/okunamadı/);
  });

  it('bölüm ve anahtar eksikliğini adıyla bildirir', () => {
    const config = parse(rawConfig());
    expect(requireSection(config, 'smoke', ['payer', 'screener']).paymentCategory).toBe('research');
    expect(() => requireSection(config, 'smoke', ['payer', 'buyer', 'keeper'])).toThrow(/buyer, keeper/);
    const { init: _, ...noInit } = rawConfig();
    expect(() => requireSection(parse(noInit), 'init', [])).toThrow(/"init" bölümü yok/);
  });
});
