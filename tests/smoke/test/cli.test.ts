import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import type { Prover } from '@squaresdk/solana-policy';
import { describe, expect, it } from 'vitest';
import { defaultReportPath, isEntryPoint, parseCli, writeText } from '../src/cli.js';
import { ClusterConfigSchema } from '../src/config.js';
import { REPO_ROOT } from '../src/keys.js';
import { localnetConfig, localnetProgramIds, parseLocalnetArgs } from '../src/localnet.js';
import { earliestProofTime, newRunId, proverFor, SAME_DAY_MARGIN_SECS, utc } from '../src/smoke.js';
import { IDS, tempDir } from './helpers.js';

describe('parseCli', () => {
  it('init ve smoke; yapılandırma bayraktan ya da SMOKE_CONFIG ortamından', () => {
    expect(parseCli(['init', '--config', 'a.json'])).toEqual({
      command: 'init',
      config: join(process.cwd(), 'a.json'),
      output: null,
    });
    expect(parseCli(['init', '--records', '/r.md'], { SMOKE_CONFIG: '/c.json' })).toEqual({
      command: 'init',
      config: '/c.json',
      output: '/r.md',
    });
    expect(parseCli(['smoke', '--config', '/c.json', '--report', '/o.md']).output).toBe('/o.md');
  });

  it('bilinmeyen komut, eksik yapılandırma ve yanlış çıktı bayrağı reddedilir', () => {
    expect(() => parseCli(['deploy', '--config', 'a'])).toThrow(/kullanım/);
    expect(() => parseCli(['smoke', 'extra', '--config', 'a'])).toThrow(/kullanım/);
    expect(() => parseCli(['smoke'])).toThrow(/SMOKE_CONFIG/);
    expect(() => parseCli(['init', '--config', 'a', '--report', 'r'])).toThrow(/--report yalnızca smoke/);
    expect(() => parseCli(['smoke', '--config', 'a', '--records', 'r'])).toThrow(/--records yalnızca init/);
  });

  it('rapor yolu, dosya yazımı ve giriş noktası', () => {
    expect(defaultReportPath('devnet')).toBe(join(REPO_ROOT, 'docs/deploy/smoke-devnet.md'));
    const dir = tempDir();
    writeText(join(dir, 'a/b.md'), 'x');
    writeText(join(dir, 'c.md'), 'y\n');
    expect(readFileSync(join(dir, 'a/b.md'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(dir, 'c.md'), 'utf8')).toBe('y\n');
    const script = join(dir, 'c.md');
    symlinkSync(script, join(dir, 'link.md'));
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, 'link.md'))).toBe(true);
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, 'a/b.md'))).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, join(dir, 'missing'))).toBe(false);
    expect(isEntryPoint(pathToFileURL(script).href, undefined)).toBe(false);
  });
});

describe('localnet koşucusu', () => {
  it("program kimlikleri Anchor.toml [programs.localnet]'ten", () => {
    const ids = localnetProgramIds(readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8'));
    expect(ids).toEqual(IDS);
    expect(() => localnetProgramIds('[toolchain]\n')).toThrow(/programs\.localnet/);
    expect(() => localnetProgramIds('[programs.localnet]\nsquare_policy = "x"\n[provider]')).toThrow(/square_registry/);
  });

  it('bayraklar ve varsayılanlar', () => {
    const defaults = parseLocalnetArgs([]);
    expect(defaults).toMatchObject({
      rpcPort: 8899,
      faucetPort: 9900,
      gossipPort: 8001,
      dynamicPortRange: '8100-8200',
    });
    expect(defaults.deployDir).toBe(join(REPO_ROOT, 'target/deploy'));
    expect(defaults.report).toBe(join(REPO_ROOT, 'docs/deploy/smoke-localnet.md'));
    const custom = parseLocalnetArgs(['--rpc-port', '48899', '--dynamic-port-range', '48100-48200', '--ledger', '/l']);
    expect(custom).toMatchObject({ rpcPort: 48899, dynamicPortRange: '48100-48200', ledger: '/l' });
    expect(() => parseLocalnetArgs(['--rpc-port', '0'])).toThrow(/rpc-port/);
    expect(() => parseLocalnetArgs(['--dynamic-port-range', '1:2'])).toThrow(/dynamic-port-range/);
  });

  it('üretilen yapılandırma şemadan geçer (ADR 0016 kuralları, kısa challenge)', () => {
    const key = () => Keypair.generate().publicKey;
    const config = ClusterConfigSchema.parse(
      localnetConfig({
        rpcUrl: 'http://127.0.0.1:8899',
        programIds: IDS,
        mint: key(),
        arbitrators: [key(), key(), key()],
        screener: key(),
        mppAuthority: key(),
      }),
    );
    expect(config.init!.escrow.params.minChallengePeriod).toBe(1n);
    expect(config.smoke!.challengePeriodSecs).toBeLessThan(SAME_DAY_MARGIN_SECS);
  });
});

describe('smoke yardımcıları', () => {
  it('koşu kimliği agent kimliğine sığar', () => {
    const id = newRunId(new Date('2026-10-06T09:41:56Z'));
    expect(id).toMatch(/^20261006094156-[0-9a-f]{4}$/);
    expect(`smoke-${id}`.length).toBeLessThanOrEqual(32);
    expect(utc(1_790_000_000)).toBe('2026-09-21T14:13:20Z');
  });

  it('finalize ispatla aynı UTC gününde kalmazsa ispat ertesi güne bırakılır (ADR 0012)', () => {
    const day = 1_790_035_200; // 2026-09-22T00:00:00Z
    expect(earliestProofTime(day + 3_600, day + 3_660)).toBe(day + 3_600);
    expect(earliestProofTime(day + 86_400 - 300, day + 86_400 - 200)).toBe(day + 86_400 - 300);
    expect(earliestProofTime(day + 86_400 - 300, day + 86_400 - 100)).toBe(day + 86_400 + 2);
    expect(earliestProofTime(day + 86_400 - 100, day)).toBe(day + 86_400 + 2);
    expect(earliestProofTime(day + 86_400 - 100, day, 50)).toBe(day + 86_400 - 100);
  });

  it('bölüme özel prover verilmişse o kullanılır (fiat dahil), yoksa ortak prover', () => {
    const prover = (name: string): Prover => ({
      prove: () => Promise.reject(new Error(name)),
    });
    const shared = prover('ortak');
    const fiat = prover('fiat');
    const remote = prover('uzak');
    const options = { prover: shared, provers: { fiat, 'ispat-yok': remote } };
    expect(proverFor(options, 'fiat')).toBe(fiat);
    expect(proverFor(options, 'ispat-yok')).toBe(remote);
    expect(proverFor(options, 'akış')).toBe(shared);
    expect(proverFor({ prover: shared }, 'fiat')).toBe(shared);
  });
});
