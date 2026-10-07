// Yapılandırma şeması: geçerli JSON / YAML yüklenir, yollar dosyaya göre çözülür; geçersiz yapılandırma ve politika
// açılışta bütün sorunlarıyla reddedilir.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  HostedConfigError,
  assertEnv,
  envValue,
  loadHostedConfig,
  loadPolicyDocument,
  parseDocument,
  parseHostedConfig,
  requiredEnv,
} from '../src/config.js';
import { legalPerson, LIMITS, policyDocument, rawConfig } from './helpers/config.js';

let dir: string;
const mint = Keypair.generate().publicKey.toBase58();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hosted-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Yapılandırma ham değerinin bütün sorunları. */
function issues(raw: unknown): string[] {
  try {
    parseHostedConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(HostedConfigError);
    return [...(error as HostedConfigError).issues];
  }
  throw new Error('yapılandırma kabul edildi');
}

const capability = (overrides: Record<string, unknown> = {}) => ({
  ...(rawConfig().capabilities as Record<string, unknown>[])[0],
  ...overrides,
});

const delegation = {
  policyFile: './policy.yaml',
  defaultCategory: 'research',
  allowedAgents: [{ agentRecord: Keypair.generate().publicKey.toBase58() }],
  deadlineSecs: 3_600,
  challengePeriodSecs: 3_600,
  ledgerPath: './state/ledger.json',
};

describe('geçerli yapılandırma', () => {
  it('YAML dosyası yüklenir; varsayılanlar dolar, yollar dosyanın dizinine göre mutlak olur', async () => {
    writeFileSync(join(dir, 'policy.yaml'), stringify(policyDocument(mint)));
    const config = rawConfig({
      signers: {
        agent: { type: 'keypair', keypairPath: './agent.json' },
        institution: { type: 'keypair', keypairPath: '/etc/square/kurum.json' },
      },
      capabilities: [capability(), capability({ id: 'delegate', tools: [], delegation: true })],
      delegation,
    });
    writeFileSync(join(dir, 'hosted.yaml'), stringify(config));
    const loaded = await loadHostedConfig(join(dir, 'hosted.yaml'));
    expect(loaded.baseDir).toBe(dir);
    expect(loaded.config.signers.agent.keypairPath).toBe(join(dir, 'agent.json'));
    expect(loaded.config.signers.institution).toEqual({ type: 'keypair', keypairPath: '/etc/square/kurum.json' });
    expect(loaded.config.delegation!.ledgerPath).toBe(join(dir, 'state/ledger.json'));
    expect(loaded.config.capabilities[0]!.contentType).toBe('text/markdown; charset=utf-8');
    expect(loaded.config.capabilities[1]!.delegation).toBe(true);
    expect(loaded.config.capabilities[0]!.delegation).toBe(false);
    expect(loaded.policy!.maxPerTx).toBe('5000000');
  });

  it('JSON dosyası; delegasyon yoksa politika okunmaz', async () => {
    writeFileSync(join(dir, 'hosted.json'), JSON.stringify(rawConfig()));
    const loaded = await loadHostedConfig(join(dir, 'hosted.json'));
    expect(loaded.policy).toBeNull();
    expect(loaded.config.capabilities.map((c) => c.id)).toEqual(['text.echo']);
  });

  it('imzasız kurum imzacısının outbox dizini ve ispat bağlamanın sır dosyası çözülür', async () => {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify(policyDocument(mint)));
    const config = rawConfig({
      signers: {
        agent: { type: 'keypair', keypairPath: 'agent.json' },
        institution: { type: 'unsigned', publicKey: mint, outboxDir: 'outbox' },
      },
      delegation: { ...delegation, policyFile: 'policy.json' },
    });
    writeFileSync(join(dir, 'hosted.yml'), stringify(config));
    const loaded = await loadHostedConfig(join(dir, 'hosted.yml'));
    expect(loaded.config.signers.institution).toEqual({
      type: 'unsigned',
      publicKey: mint,
      outboxDir: join(dir, 'outbox'),
    });

    const withDuties = rawConfig({
      signers: {
        agent: { type: 'keypair', keypairPath: 'agent.json' },
        institution: { type: 'keypair', keypairPath: 'kurum.json' },
      },
      delegation: { ...delegation, policyFile: 'policy.json' },
      duties: {
        intervalMs: 1_000,
        discovery: { api: false },
        policyWatch: {
          policySecretPath: 'secret.hex',
          paymentCategory: 'research',
          intervalMs: 500,
          prover: { baseUrl: 'https://prover.square.test', apiKeyEnv: 'PROVER_API_KEY', artifactVersion: 'v1' },
        },
        crank: { executeResolution: true, lapseDispute: true },
      },
    });
    writeFileSync(join(dir, 'duties.yaml'), stringify(withDuties));
    const duties = await loadHostedConfig(join(dir, 'duties.yaml'));
    expect(duties.config.duties!.policyWatch!.policySecretPath).toBe(join(dir, 'secret.hex'));
    expect(requiredEnv(duties.config)).toEqual(['DATABASE_URL', 'PROVER_API_KEY', 'SQUARE_API_KEY', 'TOOLS_TOKEN']);
  });
});

describe('geçersiz yapılandırma açılışta reddedilir', () => {
  it('sınırları olmayan capability, bilinmeyen alan ve yanlış sürüm', () => {
    const { limits: _limits, ...withoutLimits } = capability();
    const found = issues({ ...rawConfig({ capabilities: [withoutLimits] }), version: 2, extra: true });
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^version:/),
        expect.stringMatching(/^capabilities\.0\.limits:/),
        expect.stringMatching(/^\(kök\): .*extra/),
      ]),
    );
  });

  it("allowlist'te tanımsız MCP sunucusu, alt çizgili sunucu adı, tekrar eden capability ve tool", () => {
    const found = issues(
      rawConfig({
        mcp: { ...(rawConfig().mcp as object), servers: { my_tools: { type: 'http', url: 'https://mcp.test/mcp' } } },
        capabilities: [capability({ tools: [{ server: 'yok', allow: ['echo', 'echo'] }] }), capability()],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^mcp\.servers\.my_tools:/),
        expect.stringMatching(/^capabilities\.0\.tools\.0\.allow: tool tekrar edemez/),
      ]),
    );
    // Şema geçince çapraz denetimler: tekrar eden capability.
    expect(issues(rawConfig({ capabilities: [capability(), capability()] }))).toEqual([
      'capabilities: capability kimlikleri tekrar edemez',
    ]);
    const unknown = issues(rawConfig({ capabilities: [capability({ tools: [{ server: 'yok', allow: ['echo'] }] })] }));
    expect(unknown).toContain('capabilities.0.tools.0.server: mcp.servers içinde yok yok');
  });

  it('stdio MCP sunucusuna imza anahtarı ya da keypair dosyası verilemez', () => {
    const base = rawConfig() as { mcp: { servers: Record<string, unknown> }; signers: Record<string, unknown> };
    const stdio = (extra: Record<string, unknown>) =>
      rawConfig({
        mcp: {
          ...base.mcp,
          servers: { ...base.mcp.servers, square: { type: 'stdio', command: 'square-mcp', ...extra } },
        },
      });
    expect(issues(stdio({ env: { SQUARE_SIGNER_KEYPAIR: { fromEnv: 'KEY_FILE' } } }))).toContain(
      'mcp.servers.square.env.SQUARE_SIGNER_KEYPAIR: MCP sunucusuna imza anahtarı verilemez: imza delegasyon kapısının dışında atılırdı',
    );
    const agentKey = (base.signers.agent as { keypairPath: string }).keypairPath;
    expect(issues(stdio({ args: ['--keypair', agentKey] }))).toContain(
      'mcp.servers.square.args.1: MCP sunucusuna agent ya da kurum keypair dosyası verilemez',
    );
    expect(() => parseHostedConfig(stdio({ env: { SQUARE_API_URL: 'https://api.square.test' } }))).not.toThrow();
  });

  it('sınırlar: sıfır, maxTokens > maxTotalTokens, çok tur', () => {
    const found = issues(
      rawConfig({
        capabilities: [
          capability({ limits: { ...LIMITS, timeoutMs: 0, maxTurns: 101, maxTokens: 50_000, maxTotalTokens: 1_000 } }),
        ],
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^capabilities\.0\.limits\.timeoutMs:/),
        expect.stringMatching(/^capabilities\.0\.limits\.maxTurns:/),
      ]),
    );
    expect(
      issues(
        rawConfig({ capabilities: [capability({ limits: { ...LIMITS, maxTokens: 50_000, maxTotalTokens: 1_000 } })] }),
      ),
    ).toEqual(["capabilities.0.limits.maxTokens: maxTokens, maxTotalTokens'tan büyük olamaz"]);
  });

  it('delegasyon bölümü ve kurum imzacısı olmadan delegasyon; keypair olmadan duty', () => {
    expect(issues(rawConfig({ capabilities: [capability({ delegation: true })] }))).toEqual(
      expect.arrayContaining(['capabilities.0.delegation: delegasyon açık ama delegation bölümü yok']),
    );
    expect(issues(rawConfig({ delegation }))).toEqual(['signers.institution: delegasyon kurumun imzacısını ister']);
    const unsigned = issues(
      rawConfig({
        signers: {
          agent: { type: 'keypair', keypairPath: 'a.json' },
          institution: { type: 'unsigned', publicKey: mint },
        },
        duties: {
          intervalMs: 1_000,
          discovery: { api: true },
          crank: { executeResolution: true, lapseDispute: false },
        },
      }),
    );
    expect(unsigned).toEqual([
      "signers.institution: duty'ler kurumun yerel keypair imzacısını ister (zamana bağlı tx'ler)",
    ]);
    expect(
      issues(
        rawConfig({
          signers: {
            agent: { type: 'keypair', keypairPath: 'a.json' },
            institution: { type: 'keypair', keypairPath: 'k.json' },
          },
          duties: { intervalMs: 1_000, discovery: { api: true } },
        }),
      ),
    ).toEqual(['duties: en az bir duty (policyWatch, crank) açılmalı']);
  });

  it('Travel Rule oturumu API_AUTH_DOMAIN ister', () => {
    const signers = {
      agent: { type: 'keypair', keypairPath: 'a.json' },
      institution: { type: 'keypair', keypairPath: 'k.json' },
    };
    const withTravelRule = {
      ...delegation,
      travelRule: { originator: legalPerson('Kurum A.Ş.', mint), originatingVasp: null },
    };
    expect(issues(rawConfig({ signers, delegation: withTravelRule }))).toEqual([
      "api.authDomain: Travel Rule oturumu API'nin API_AUTH_DOMAIN'ini ister",
    ]);
    const api = { baseUrl: 'https://api.square.test', apiKeyEnv: 'SQUARE_API_KEY', authDomain: 'app.square.test' };
    expect(() => parseHostedConfig(rawConfig({ signers, delegation: withTravelRule, api }))).not.toThrow();
  });

  it('https olmayan public URL, A2A http adresi, bozuk kayıt kimliği ve fiyat', () => {
    const found = issues(
      rawConfig({
        agent: { ...(rawConfig().agent as object), publicUrl: 'http://agent.test', agentId: 'kurum ajanı' },
        capabilities: [capability({ price: '-1' })],
        signers: {
          agent: { type: 'keypair', keypairPath: 'a.json' },
          institution: { type: 'unsigned', publicKey: mint },
        },
        delegation: {
          ...delegation,
          allowedAgents: [{ agentRecord: mint, a2a: { url: 'http://agent.test/a2a', apiKeyEnv: 'AGENT_KEY' } }],
        },
      }),
    );
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^agent\.publicUrl:/),
        expect.stringMatching(/^agent\.agentId:/),
        expect.stringMatching(/^capabilities\.0\.price:/),
        'delegation.allowedAgents.0.a2a.url: A2A uç noktası https olmalı (yerel deneme için allowInsecureHttp)',
      ]),
    );
  });

  it('bozuk dosya, bilinmeyen uzantı ve okunamayan dosya', async () => {
    writeFileSync(join(dir, 'bozuk.yaml'), 'agent: [\n');
    await expect(loadHostedConfig(join(dir, 'bozuk.yaml'))).rejects.toThrow(/çözümlenemedi/);
    expect(() => parseDocument('{}', 'hosted.toml')).toThrow(/uzantı/);
    await expect(loadHostedConfig(join(dir, 'yok.yaml'))).rejects.toThrow(/okunamadı/);
  });

  it('geçersiz politika belgesi yapılandırmayı düşürür', async () => {
    writeFileSync(join(dir, 'policy.yaml'), stringify({ ...policyDocument(mint), allowedCategories: [] }));
    writeFileSync(
      join(dir, 'hosted.yaml'),
      stringify(
        rawConfig({
          signers: {
            agent: { type: 'keypair', keypairPath: 'a.json' },
            institution: { type: 'unsigned', publicKey: mint },
          },
          delegation,
        }),
      ),
    );
    const error = await loadHostedConfig(join(dir, 'hosted.yaml')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostedConfigError);
    expect((error as HostedConfigError).issues).toEqual([expect.stringMatching(/^allowedCategories:/)]);
    await expect(loadPolicyDocument(join(dir, 'yok.yaml'))).rejects.toThrow(/politika belgesi okunamadı/);
  });
});

describe('ortam', () => {
  it('eksik değişkenler adlarıyla raporlanır, değerler raporlanmaz', () => {
    const config = parseHostedConfig(rawConfig());
    expect(requiredEnv(config)).toEqual(['DATABASE_URL', 'SQUARE_API_KEY', 'TOOLS_TOKEN']);
    const error = (() => {
      try {
        assertEnv(config, { SQUARE_API_KEY: 'sqk_gizli' });
      } catch (e) {
        return e as HostedConfigError;
      }
      return null;
    })();
    expect(error!.issues).toEqual(['DATABASE_URL tanımlı değil', 'TOOLS_TOKEN tanımlı değil']);
    expect(error!.message).not.toContain('sqk_gizli');
    expect(() => assertEnv(config, { SQUARE_API_KEY: 'a', DATABASE_URL: 'b', TOOLS_TOKEN: 'c' })).not.toThrow();
    expect(envValue('düz', {})).toBe('düz');
    expect(() => envValue({ fromEnv: 'YOK' }, {})).toThrow(/YOK tanımlı değil/);
  });
});
