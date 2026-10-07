// Kabul: "konfigürasyondan agent ayağa kalkıp job teslim ediyor; delegasyon politika limitine uyuyor". Agent YAML
// dosyasından `runFromConfig` ile kurulur (keypair dosyaları, politika belgesi, stdio MCP sunucusu alt süreç olarak),
// zincire kaydolur ve A2A'dan gelen işi Claude çalıştırmasıyla (sahte Messages istemcisi) yürütüp teslim eder.
// Delegasyon capability'si başka bir agent'a (agent-sdk ile kurulmuş gerçek bir A2A agent'ı) job açar ve fonlar; o
// agent işi kabul edip teslim eder; politika tavanını aşan ikinci delegasyon tx'siz reddedilir. Zincir benzetimdir
// (test/helpers/sim.ts), görev deposu gerçek Postgres'tir.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createA2aClient, createApiKeyAuthenticator } from '@squaresdk/solana-a2a';
import { createPrismaTaskStore } from '@squaresdk/solana-a2a/prisma';
import { createAgent, type Agent } from '@squaresdk/solana-agent-sdk';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { specHashing } from '@squaresdk/solana-sdk';
import type { Task } from '@squaresdk/solana-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { HostedAgent } from '../src/hosted.js';
import { runFromConfig } from '../src/runner.js';
import { FakeApi } from './helpers/api.js';
import { fakeClaude, lastToolResults, text, toolUse, toolNames } from './helpers/claude.js';
import { LIMITS, policyDocument, rawConfig } from './helpers/config.js';
import { SimChain } from './helpers/sim.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const FIXTURE = fileURLToPath(new URL('./fixtures/tools-mcp.mjs', import.meta.url));
const CALLER_KEY = 'musteri-kurum-anahtari';
const WORKER_KEY = 'hosted-kurum-anahtari';
const ECHO_SYSTEM = 'Use the echo tool on the input and report its output.';
const DELEGATE_SYSTEM = 'Hire the translation agent for the work and report the delegation results.';

let db: IsolatedDatabase;
let dir: string;
let hosted: HostedAgent;
let worker: Agent;
let url: string;
const sim = new SimChain();
const api = new FakeApi();
const workerApi = new FakeApi();
const agentKeypair = Keypair.generate();
const institution = Keypair.generate();
const workerKeypair = Keypair.generate();
const customer = Keypair.generate().publicKey;

const fake = fakeClaude((params) => {
  const results = lastToolResults(params);
  if (params.system === ECHO_SYSTEM) {
    if (results.length === 0) {
      const input = (params.messages[0]!.content as string).trim();
      return toolUse([
        { name: 'tools__echo', input: { text: input } },
        { name: 'tools__secret_read', input: { key: 'hazine' } },
      ]);
    }
    return text(`Sonuç: ${results[0]!.content as string}`);
  }
  // Delegasyon: önce izinli tutar, sonra işlem başı tavanı aşan tutar; sonra iki sonucun durumu.
  const turn = params.messages.filter((m) => m.role === 'assistant').length;
  if (turn === 0) {
    return toolUse([
      {
        name: 'square_delegate_job',
        input: {
          agentRecord: worker.agentRecord.toBase58(),
          spec: { capability: 'text.upper', input: 'delegated work' },
          amount: '2000000',
        },
      },
    ]);
  }
  if (turn === 1) {
    return toolUse([
      {
        name: 'square_delegate_job',
        input: {
          agentRecord: worker.agentRecord.toBase58(),
          spec: { capability: 'text.upper', input: 'too expensive' },
          amount: '9000000',
        },
      },
    ]);
  }
  const statuses = params.messages
    .flatMap((m) => (m.role === 'user' && typeof m.content !== 'string' ? m.content : []))
    .filter((b) => b.type === 'tool_result')
    .map((b) => JSON.parse((b as { content: string }).content) as { status: string; rules?: string[] });
  return text(JSON.stringify(statuses.map((s) => ({ status: s.status, rules: s.rules ?? [] }))));
});

beforeAll(async () => {
  db = await startIsolatedDatabase();
  dir = mkdtempSync(join(tmpdir(), 'hosted-e2e-'));
  await sim.setConfig();

  // Delegasyonun hedefi: agent-sdk ile kurulmuş, kurumun anahtarını tanıyan çeviri agent'ı.
  worker = await createAgent({
    name: 'Çeviri Ajanı',
    description: 'Metni büyük harfe çevirir',
    version: '1.0.0',
    publicUrl: 'https://worker.square.test',
    agentId: 'ceviri-ajani',
    capabilities: [
      { id: 'text.upper', name: 'Büyük harf', description: 'Büyük harf', tags: ['text'], price: 1_000_000n },
    ],
    handler: async (request) => String((request.spec as { input: string }).input).toUpperCase(),
    signer: workerKeypair,
    connection: sim.connection(),
    programIds: sim.client.programIds,
    api: workerApi.client(),
    store: createPrismaTaskStore(db.client),
    authenticate: createApiKeyAuthenticator({
      keys: [{ keySha256: sha(WORKER_KEY), institutions: [institution.publicKey.toBase58()] }],
    }),
  });
  await sim.setAgentRecord(worker.agentRecord, workerKeypair.publicKey);
  const workerServer = await worker.listen({ port: 0, host: '127.0.0.1' });
  const workerUrl = `http://127.0.0.1:${(workerServer.address() as AddressInfo).port}/a2a`;

  writeFileSync(join(dir, 'agent.json'), JSON.stringify(Array.from(agentKeypair.secretKey)));
  writeFileSync(join(dir, 'kurum.json'), JSON.stringify(Array.from(institution.secretKey)));
  writeFileSync(join(dir, 'policy.yaml'), stringify(policyDocument(sim.settlementMint.toBase58())));
  const base = rawConfig() as { capabilities: Record<string, unknown>[]; agent: Record<string, unknown> };
  const config = rawConfig({
    agent: {
      ...base.agent,
      register: 'self',
      callers: [{ keySha256: sha(CALLER_KEY), institutions: [customer.toBase58()] }],
    },
    signers: {
      agent: { type: 'keypair', keypairPath: 'agent.json' },
      institution: { type: 'keypair', keypairPath: 'kurum.json' },
    },
    mcp: {
      servers: {
        tools: {
          type: 'stdio',
          command: process.execPath,
          args: [FIXTURE],
          env: { TOOLS_MCP_CALL_LOG: { fromEnv: 'TOOLS_MCP_CALL_LOG' } },
        },
      },
      maxConcurrency: 2,
      toolCacheTtlMs: 60_000,
      requestTimeoutMs: 15_000,
      reconnect: { maxAttempts: 2, backoffMs: 50, maxBackoffMs: 200 },
    },
    capabilities: [
      { ...base.capabilities[0], instructions: ECHO_SYSTEM },
      {
        id: 'research.delegate',
        name: 'Delegasyon',
        description: 'İşi kurumun politikası altında başka bir agent’a verir',
        tags: ['delegation'],
        price: '1000000',
        instructions: DELEGATE_SYSTEM,
        model: 'claude-opus-5-5',
        delegation: true,
        limits: LIMITS,
      },
    ],
    delegation: {
      policyFile: 'policy.yaml',
      defaultCategory: 'translation',
      allowedAgents: [
        {
          agentRecord: worker.agentRecord.toBase58(),
          a2a: { url: workerUrl, apiKeyEnv: 'WORKER_KEY', allowInsecureHttp: true },
        },
      ],
      deadlineSecs: 3_600,
      challengePeriodSecs: 600,
      maxJobsPerDay: 20,
      ledgerPath: 'state/ledger.json',
    },
  });
  writeFileSync(join(dir, 'hosted.yaml'), stringify(config));

  const started = await runFromConfig(
    { config: join(dir, 'hosted.yaml'), check: false },
    {
      SQUARE_API_KEY: 'sqk_test',
      DATABASE_URL: db.url,
      TOOLS_MCP_CALL_LOG: join(dir, 'calls.log'),
      WORKER_KEY,
    },
    {
      store: createPrismaTaskStore(db.client),
      anthropic: fake.client,
      connection: sim.connection(),
      extra: { api: api.client() },
    },
  );
  hosted = started.hosted!;
  url = `http://127.0.0.1:${(hosted.server!.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await hosted?.close();
  await worker?.close();
  await db?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function runTask(spec: Record<string, unknown>, amount: bigint): Promise<{ task: Task; job: PublicKey }> {
  const job = Keypair.generate().publicKey;
  const specHash = Buffer.from(specHashing.specHash(spec)).toString('hex');
  await sim.setJob(job, {
    institution: customer,
    agentRecord: hosted.agent.agentRecord,
    agentWallet: agentKeypair.publicKey,
    amount,
    specHash,
    status: 'funded',
    deadline: Math.floor(Date.now() / 1000) + 3_600,
  });
  const a2a = createA2aClient({
    url: `${url}/a2a`,
    timeoutMs: 30_000,
    allowInsecureHttp: true,
    headers: { 'x-api-key': CALLER_KEY },
  });
  const sent = await a2a.sendMessage({
    message: {
      messageId: `m-${job.toBase58()}`,
      role: 'ROLE_USER',
      parts: [{ data: spec as never, mediaType: 'application/json' }],
      metadata: { square: { job: job.toBase58(), specHash } },
    },
  });
  let task = (sent as { task: Task }).task;
  const deadline = Date.now() + 30_000;
  while (!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(task.status.state)) {
    if (Date.now() > deadline) throw new Error(`görev bitmedi: ${task.status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    task = await a2a.getTask({ id: task.id, historyLength: 20 });
  }
  return { task, job };
}

describe('konfigürasyondan hosted agent', () => {
  it('yapılandırmadaki kimlikle kaydolur; kart capability’leri ve fiyatları taşır', async () => {
    const record = await sim.client.registry.fetch('agentRecord', hosted.agent.agentRecord);
    expect(record!.agentCardUri).toBe('https://kurum-ajani.square.test/.well-known/agent-card.json');
    expect(Buffer.from(record!.agentCardHash).toString('hex')).toBe(hosted.agent.cardHash);
    expect(record!.wallet.equals(agentKeypair.publicKey)).toBe(true);
    expect(hosted.agent.card.skills.map((skill) => skill.id)).toEqual(['text.echo', 'research.delegate']);
    expect(hosted.agent.card.pricing).toEqual([
      { skillId: 'text.echo', amount: '1000000', mint: sim.settlementMint.toBase58() },
      { skillId: 'research.delegate', amount: '1000000', mint: sim.settlementMint.toBase58() },
    ]);
    const served = new Uint8Array(await (await fetch(`${url}/.well-known/agent-card.json`)).arrayBuffer());
    expect(sha(served)).toBe(hosted.agent.cardHash);
  });

  it('A2A işi: kabul → Claude + izinli MCP tool’u → teslimat → submit_work; izinsiz tool sunucuya ulaşmaz', async () => {
    const spec = { capability: 'text.echo', input: 'merhaba dünya' };
    const { task, job } = await runTask(spec, 3_000_000n);
    expect(task.status.state, JSON.stringify(task.status)).toBe('TASK_STATE_COMPLETED');
    expect(sim.jobStatus(job)).toBe('delivered');
    const upload = api.uploads.find((item) => item.job === job.toBase58())!;
    expect(Buffer.from(upload.content).toString('utf8')).toBe('Sonuç: echo: merhaba dünya');
    expect(upload.contentType).toBe('text/markdown; charset=utf-8');
    expect(Buffer.from(sim.job(job)!.workHash).toString('hex')).toBe(sha(upload.content));
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls).toEqual([{ tool: 'echo', args: { text: 'merhaba dünya' } }]);
    const echoRequest = fake.requests.find((r) => r.system === ECHO_SYSTEM)!;
    expect(toolNames(echoRequest)).toEqual(['tools__echo']);
    expect(echoRequest.model).toBe('claude-opus-5-5');
    expect(hosted.stats()['text.echo']).toMatchObject({ completed: 1, deniedToolCalls: 1 });
  });

  it('fiyatın altındaki iş zincire tx gönderilmeden reddedilir', async () => {
    const before = sim.sent.length;
    const { task } = await runTask({ capability: 'text.echo', input: 'ucuz' }, 999_999n);
    expect(task.status.state).toBe('TASK_STATE_REJECTED');
    expect(sim.sent.length).toBe(before);
  });

  it('delegasyon: izinli tutar başka agent’a job açar ve fonlar, o agent teslim eder; tavanı aşan tx’siz reddedilir', async () => {
    const spec = { capability: 'research.delegate', input: 'çeviriyi dışarı ver' };
    const before = sim.sent.length;
    const { task } = await runTask(spec, 2_000_000n);
    expect(task.status.state, JSON.stringify(task.status)).toBe('TASK_STATE_COMPLETED');
    const report = api.uploads.at(-1)!;
    expect(JSON.parse(Buffer.from(report.content).toString('utf8'))).toEqual([
      { status: 'funded', rules: [] },
      // 2 + 9 birim: işlem başı (5), gizli günlük (8) ve public günlük (10) tavanların üçü de aşılır.
      { status: 'refused', rules: ['perTx', 'dailyPrivate', 'dailyCeiling'] },
    ]);
    // Delegasyon tx'leri kurumun anahtarıyla: create_job + fund_job; reddedilen için tx yok.
    const delegated = sim.client.pda.job(
      institution.publicKey,
      specHashing.specHash({ capability: 'text.upper', input: 'delegated work' }),
    )[0];
    const names = sim.sent.slice(before).map((ix) => `${ix.name}:${ix.signers[0]}`);
    expect(names).toEqual(
      expect.arrayContaining([
        `createJob:${institution.publicKey.toBase58()}`,
        `fundJob:${institution.publicKey.toBase58()}`,
      ]),
    );
    expect(sim.sent.filter((ix) => ix.name === 'createJob')).toHaveLength(1);
    // Hedef agent işi A2A'dan aldı, kabul edip teslim etti.
    const deadline = Date.now() + 20_000;
    while (sim.jobStatus(delegated) !== 'delivered' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(sim.jobStatus(delegated)).toBe('delivered');
    expect(Buffer.from(workerApi.uploads.at(-1)!.content).toString('utf8')).toBe('DELEGATED WORK');
    // Defter dosyada: günlük sayaç ve hedef agent'taki görev.
    const ledger = JSON.parse(readFileSync(join(dir, 'state', 'ledger.json'), 'utf8')) as {
      entries: { job: string; amount: string; status: string; task?: string }[];
    };
    expect(ledger.entries).toEqual([
      expect.objectContaining({
        job: delegated.toBase58(),
        amount: '2000000',
        status: 'funded',
        task: expect.any(String),
      }),
    ]);
  });
});
