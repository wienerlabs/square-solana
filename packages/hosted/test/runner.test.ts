// Çalıştırıcı ve kurulum: argümanlar, `--check` (yapılandırma, anahtar dosyaları, politika sırrı ve ortam başlatmadan
// doğrulanır), bağımlılıkların yapılandırmadan kurulması, imzasız tx'in outbox'a yazılması, eksik imzacı / politika
// ile kurulumun reddi ve duty'lerin `start` ile başlaması.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import type { TaskStore } from '@squaresdk/solana-a2a';
import { derivePolicySalts } from '@squaresdk/solana-policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { HostedConfigError, loadHostedConfig, parseHostedConfig } from '../src/config.js';
import { createHostedAgent, mcpTargetsFromConfig } from '../src/hosted.js';
import { readKeypairFile } from '../src/signer.js';
import { depsFromConfig, parseArgs, readPolicySecret, runFromConfig, writeUnsignedTx } from '../src/runner.js';
import { FakeApi } from './helpers/api.js';
import { fakeClaude, text } from './helpers/claude.js';
import { policyDocument, rawConfig } from './helpers/config.js';
import { SimChain } from './helpers/sim.js';

let dir: string;
const agent = Keypair.generate();
const institution = Keypair.generate();
const SECRET = 'ab'.repeat(32);
const ENV = { SQUARE_API_KEY: 'sqk', DATABASE_URL: 'postgres://x', TOOLS_TOKEN: 't', PROVER_API_KEY: 'p' };
/** Yeniden başlatmada okunan tek yöntem; bu testlerde görev açılmaz. */
const store = { active: async () => [] } as unknown as TaskStore;

function writeFiles(config: Record<string, unknown>, mint = Keypair.generate().publicKey.toBase58()) {
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(Array.from(agent.secretKey)));
  writeFileSync(join(dir, 'kurum.json'), JSON.stringify(Array.from(institution.secretKey)));
  writeFileSync(join(dir, 'secret.hex'), `${SECRET}\n`);
  writeFileSync(join(dir, 'policy.yaml'), stringify(policyDocument(mint)));
  writeFileSync(join(dir, 'hosted.yaml'), stringify(config));
  return join(dir, 'hosted.yaml');
}

const full = (signer: Record<string, unknown> = { type: 'keypair', keypairPath: 'kurum.json' }) =>
  rawConfig({
    signers: { agent: { type: 'keypair', keypairPath: 'agent.json' }, institution: signer },
    delegation: {
      policyFile: 'policy.yaml',
      defaultCategory: 'research',
      allowedAgents: [{ agentRecord: Keypair.generate().publicKey.toBase58() }],
      deadlineSecs: 600,
      challengePeriodSecs: 600,
      maxJobsPerDay: 20,
      ledgerPath: 'ledger.json',
    },
    ...(signer.type === 'keypair' && {
      duties: {
        intervalMs: 50,
        discovery: { api: false },
        policyWatch: {
          policySecretPath: 'secret.hex',
          paymentCategory: 'research',
          intervalMs: 50,
          prover: { baseUrl: 'https://prover.square.test', apiKeyEnv: 'PROVER_API_KEY', artifactVersion: 'v1' },
        },
        crank: { executeResolution: true, lapseDispute: true },
      },
    }),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hosted-runner-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('argümanlar ve --check', () => {
  it('parseArgs', () => {
    expect(parseArgs(['--config', 'a.yaml'])).toEqual({ config: 'a.yaml', check: false });
    expect(parseArgs(['--config=a.json', '--check'])).toEqual({ config: 'a.json', check: true });
    expect(parseArgs(['-h'])).toBe('help');
    expect(() => parseArgs([])).toThrow(/--config zorunlu/);
    expect(() => parseArgs(['--config'])).toThrow(/dosya yolu/);
    expect(() => parseArgs(['--config', 'a', '--x'])).toThrow(/bilinmeyen argüman: --x/);
  });

  it('--check geçerli yapılandırmada hiçbir şey başlatmaz; eksik ortam, bozuk anahtar ve sır reddedilir', async () => {
    const path = writeFiles(full());
    const checked = await runFromConfig({ config: path, check: true }, ENV);
    expect(checked.hosted).toBeNull();
    expect(checked.loaded.config.duties!.crank).toEqual({ executeResolution: true, lapseDispute: true });

    await expect(runFromConfig({ config: path, check: true }, { ...ENV, PROVER_API_KEY: '' })).rejects.toThrow(
      HostedConfigError,
    );
    writeFileSync(join(dir, 'secret.hex'), 'kısa');
    await expect(runFromConfig({ config: path, check: true }, ENV)).rejects.toThrow(/64 hex/);
    await expect(readPolicySecret(join(dir, 'yok.hex'))).rejects.toThrow(/okunamadı/);
    writeFileSync(join(dir, 'kurum.json'), '[1,2,3]');
    await expect(runFromConfig({ config: path, check: true }, ENV)).rejects.toThrow(/64 baytlık JSON dizi/);
    await expect(readKeypairFile(join(dir, 'yok.json'))).rejects.toThrow(/okunamadı/);
  });
});

describe('bağımlılıklar', () => {
  it('keypair’ler, salt’lar (politika sırrından), uzak prover, dosya defteri ve outbox', async () => {
    const loaded = await loadHostedConfig(writeFiles(full()));
    const deps = await depsFromConfig(loaded, ENV, { store, anthropic: fakeClaude(() => text('x')).client });
    expect(deps.agentSigner.publicKey.equals(agent.publicKey)).toBe(true);
    expect(deps.institutionSigner).toMatchObject({ type: 'keypair' });
    expect(deps.institutionSigner!.publicKey.equals(institution.publicKey)).toBe(true);
    expect(deps.proofs!.salts).toEqual(
      derivePolicySalts(Buffer.from(SECRET, 'hex'), Buffer.from(loaded.policy!.policyId, 'hex')),
    );
    expect(typeof deps.proofs!.prover.prove).toBe('function');
    expect(deps.connection.rpcEndpoint).toBe('http://127.0.0.1:8899');
    deps.ledger!.put({
      job: Keypair.generate().publicKey.toBase58(),
      agentRecord: 'x',
      amount: '1',
      category: 'research',
      specHash: '00'.repeat(32),
      day: 0,
      createdAt: 0,
      status: 'reserved',
    });
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).entries).toHaveLength(1);

    const unsigned = await loadHostedConfig(
      writeFiles(full({ type: 'unsigned', publicKey: institution.publicKey.toBase58(), outboxDir: 'outbox' })),
    );
    const lines: string[] = [];
    const unsignedDeps = await depsFromConfig(unsigned, ENV, {
      store,
      anthropic: fakeClaude(() => text('x')).client,
      logger: { info: (line) => lines.push(line), error: (line) => lines.push(line) },
    });
    expect(unsignedDeps.institutionSigner).toEqual({ type: 'unsigned', publicKey: institution.publicKey });
    expect(unsignedDeps.proofs).toBeNull();
    await unsignedDeps.onUnsignedTx!({
      job: 'J',
      step: 'createJob',
      transaction: 'AA==',
      requiredSigners: ['K'],
      lastValidBlockHeight: 1,
    });
    expect(JSON.parse(readFileSync(join(dir, 'outbox', 'J-createJob.json'), 'utf8'))).toMatchObject({
      step: 'createJob',
    });
    expect(lines).toEqual([`imzasız tx: job J adım createJob → ${join(dir, 'outbox', 'J-createJob.json')}`]);
    unsignedDeps.onDutyAction!({ duty: 'crank', action: 'lapseDispute', job: 'J', signature: 'S' });
    expect(lines.at(-1)).toBe('duty crank: lapseDispute job J S');
  });

  it('writeUnsignedTx dosyayı 0600 yazar', () => {
    const path = writeUnsignedTx(join(dir, 'o'), {
      job: 'J',
      step: 'fundJob',
      transaction: 'AA==',
      requiredSigners: [],
      lastValidBlockHeight: 1,
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('MCP hedefleri: stdio ortamı ve http başlıkları ortamdan çözülür', () => {
    expect(
      mcpTargetsFromConfig(
        {
          a: {
            type: 'stdio',
            command: 'node',
            args: ['s.mjs'],
            cwd: '/tmp',
            env: { K: { fromEnv: 'TOOLS_TOKEN' }, D: 'düz' },
          },
          b: { type: 'http', url: 'https://mcp.test/mcp', headers: { authorization: { fromEnv: 'TOOLS_TOKEN' } } },
          c: { type: 'http', url: 'https://mcp.test/c' },
        },
        ENV,
      ),
    ).toEqual({
      a: { type: 'stdio', command: 'node', args: ['s.mjs'], cwd: '/tmp', env: { K: 't', D: 'düz' } },
      b: { type: 'http', url: 'https://mcp.test/mcp', headers: { authorization: 't' } },
      c: { type: 'http', url: 'https://mcp.test/c' },
    });
  });
});

describe('createHostedAgent kurulumu', () => {
  it('kurum imzacısı, politika ya da prover eksikse ve imzacı türü uyuşmazsa reddedilir', async () => {
    const sim = new SimChain();
    await sim.setConfig();
    const config = parseHostedConfig(full());
    const base = {
      connection: sim.connection(),
      store,
      anthropic: fakeClaude(() => text('x')).client,
      agentSigner: agent,
      env: ENV,
      api: new FakeApi().client(),
    };
    const keypairSigner = { type: 'keypair' as const, publicKey: institution.publicKey, keypair: institution };
    await expect(createHostedAgent(config, base)).rejects.toThrow(/kurumun imzacısını ister/);
    await expect(
      createHostedAgent(config, { ...base, institutionSigner: { type: 'unsigned', publicKey: institution.publicKey } }),
    ).rejects.toThrow(/türü yapılandırmayla aynı/);
    await expect(createHostedAgent(config, { ...base, institutionSigner: keypairSigner })).rejects.toThrow(
      /politika belgesini ister/,
    );
    const policy = policyDocument(sim.settlementMint.toBase58());
    await expect(createHostedAgent(config, { ...base, institutionSigner: keypairSigner, policy })).rejects.toThrow(
      /salt ve prover/,
    );
    // MCP hedefi verilmeyen sunucu ve zincirde olmayan escrow config'i.
    await expect(createHostedAgent(parseHostedConfig(rawConfig()), { ...base, mcpTargets: {} })).rejects.toThrow(
      /hedefi yok/,
    );
    await expect(
      createHostedAgent(parseHostedConfig(rawConfig()), { ...base, connection: new SimChain().connection() }),
    ).rejects.toThrow(/escrow config/);
  });

  it('start duty’leri başlatır, close durdurur; api verilmezse yapılandırmadan kurulur', async () => {
    const sim = new SimChain();
    await sim.setConfig();
    const policy = policyDocument(sim.settlementMint.toBase58());
    const config = parseHostedConfig(full());
    const watched: string[] = [];
    const hosted = await createHostedAgent(config, {
      connection: sim.connection(),
      store,
      anthropic: fakeClaude(() => text('x')).client,
      agentSigner: agent,
      institutionSigner: { type: 'keypair', publicKey: institution.publicKey, keypair: institution },
      policy,
      proofs: { salts: Array.from({ length: 8 }, () => 1n), prover: { prove: async () => ({}) as never } },
      env: ENV,
      watch: (params) => (watched.push(params.job.toBase58()), () => undefined),
    });
    expect(hosted.server).toBeNull();
    expect(hosted.delegator).not.toBeNull();
    expect(hosted.duties).not.toBeNull();
    expect(Object.keys(hosted.stats())).toEqual(['text.echo']);
    expect(() => hosted.runtime('yok')).toThrow(/bilinmeyen capability/);
    const server = await hosted.start();
    expect(hosted.server).toBe(server);
    await hosted.close();
    expect(hosted.server).toBeNull();
  });
});
