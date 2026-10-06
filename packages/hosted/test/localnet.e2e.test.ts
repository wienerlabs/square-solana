// Localnet kabul testi (BE-29): gerçek `solana-test-validator`'da derlenmiş dört Square programıyla hosted agent
// YAML yapılandırmasından ayağa kalkar (RPC, Postgres görev deposu ve stdio MCP sunucusu yapılandırmadan), zincire
// kaydolur, kurumun açıp fonladığı işi A2A'dan alır, Claude çalıştırmasıyla (sahte Messages istemcisi; gerçek Claude
// API'si çağrılmaz) yürütür ve `submit_work` ile teslim eder. Delegasyon kurumun anahtarıyla başka bir agent'a gerçek
// `create_job` + `fund_job` gönderir; politika tavanını aşan delegasyon tx'siz reddedilir. Yalnızca SQUARE_LOCALNET=1
// ile koşar; programlar `anchor build` çıktısıdır (`SQUARE_DEPLOY_DIR`, varsayılan repo kökündeki target/deploy).
// Teslimat Square API'sinin sözleşmesindeki uca gider; API'nin kendisi burada çalıştırılmaz (sahte fetch).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BN } from '@anchor-lang/core';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createA2aClient } from '@squaresdk/solana-a2a';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createSquareClient, SQUARE_IDLS, specHashing, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import type { Task } from '@squaresdk/solana-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { HostedAgent } from '../src/hosted.js';
import { runFromConfig } from '../src/runner.js';
import { FakeApi } from './helpers/api.js';
import { fakeClaude, lastToolResults, text, toolUse } from './helpers/claude.js';
import { LIMITS, policyDocument, rawConfig } from './helpers/config.js';

const ENABLED = process.env.SQUARE_LOCALNET === '1';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DEPLOY_DIR = process.env.SQUARE_DEPLOY_DIR ?? join(REPO_ROOT, 'target', 'deploy');
const RPC_PORT = Number(process.env.SQUARE_LOCALNET_RPC_PORT ?? 18_899);
const LEDGER = process.env.SQUARE_LOCALNET_LEDGER ?? join(tmpdir(), `square-hosted-ledger-${process.pid}`);
const FIXTURE = fileURLToPath(new URL('./fixtures/tools-mcp.mjs', import.meta.url));
const CALLER_KEY = 'localnet-musteri-anahtari';
const HOUR = 3_600;
/** 6 ondalıklı settlement mint. */
const JOB_AMOUNT = 3_000_000n;
const DELEGATED_AMOUNT = 2_000_000n;

const PROGRAMS = {
  registry: { id: SQUARE_IDLS.registry.address, so: 'square_registry.so' },
  policy: { id: SQUARE_IDLS.policy.address, so: 'square_policy.so' },
  verifier: { id: SQUARE_IDLS.verifier.address, so: 'square_verifier.so' },
  escrow: { id: SQUARE_IDLS.escrow.address, so: 'square_escrow.so' },
};

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programData = (program: PublicKey) =>
  PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

let validator: ChildProcess | null = null;
let db: IsolatedDatabase | null = null;
let hosted: HostedAgent | null = null;
let dir: string | null = null;

async function waitForRpc(connection: Connection): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await connection.getSlot('confirmed')) > 0) return;
    } catch {
      // Validator henüz açılmadı.
    }
    if (validator?.exitCode !== null && validator?.exitCode !== undefined) {
      throw new Error(`solana-test-validator çıktı: ${validator.exitCode}`);
    }
    if (Date.now() > deadline) throw new Error('validator 90 sn içinde hazır olmadı');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function send(connection: Connection, built: BuiltTx, signers: Keypair[]) {
  built.transaction.sign(signers.filter((s) => built.signers.some((key) => key.equals(s.publicKey))));
  const signature = await connection.sendRawTransaction(built.transaction.serialize());
  const { value } = await connection.confirmTransaction(
    { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
    'confirmed',
  );
  if (value.err) throw new Error(`tx düştü: ${JSON.stringify(value.err)}`);
  return signature;
}

async function sendIx(client: SquareClient, connection: Connection, ix: TransactionInstruction, signers: Keypair[]) {
  return send(connection, await client.buildTx([ix], { feePayer: signers[0]!.publicKey }), signers);
}

describe.skipIf(!ENABLED)('localnet: yapılandırmadan hosted agent → teslim; politika altında delegasyon', () => {
  const connection = new Connection(`http://127.0.0.1:${RPC_PORT}`, 'confirmed');
  const programIds = {
    registry: new PublicKey(PROGRAMS.registry.id),
    policy: new PublicKey(PROGRAMS.policy.id),
    verifier: new PublicKey(PROGRAMS.verifier.id),
    escrow: new PublicKey(PROGRAMS.escrow.id),
  };
  const client = createSquareClient({ connection, programIds, commitment: 'confirmed' });
  const admin = Keypair.generate();
  const agentWallet = Keypair.generate();
  const customer = Keypair.generate();
  const institution = Keypair.generate();
  const workerWallet = Keypair.generate();
  const api = new FakeApi();
  let mint: PublicKey;
  let workerRecord: PublicKey;

  beforeAll(async () => {
    for (const { so } of Object.values(PROGRAMS)) {
      if (!existsSync(join(DEPLOY_DIR, so))) {
        throw new Error(`${join(DEPLOY_DIR, so)} yok: anchor build ya da SQUARE_DEPLOY_DIR`);
      }
    }
    rmSync(LEDGER, { recursive: true, force: true });
    mkdirSync(LEDGER, { recursive: true });
    const args = [
      '--reset',
      '--quiet',
      '--bind-address',
      '127.0.0.1',
      '--rpc-port',
      String(RPC_PORT),
      '--faucet-port',
      process.env.SQUARE_LOCALNET_FAUCET_PORT ?? '19900',
      '--gossip-port',
      process.env.SQUARE_LOCALNET_GOSSIP_PORT ?? '18001',
      '--dynamic-port-range',
      process.env.SQUARE_LOCALNET_DYNAMIC_PORTS ?? '18100-18200',
      '--ledger',
      LEDGER,
      ...Object.values(PROGRAMS).flatMap(({ id, so }) => [
        '--upgradeable-program',
        id,
        join(DEPLOY_DIR, so),
        admin.publicKey.toBase58(),
      ]),
    ];
    validator = spawn(process.env.SOLANA_TEST_VALIDATOR ?? 'solana-test-validator', args, { stdio: 'ignore' });
    db = await startIsolatedDatabase();
    await waitForRpc(connection);

    for (const key of [admin, agentWallet, customer, institution, workerWallet]) {
      const signature = await connection.requestAirdrop(key.publicKey, 20 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, 'confirmed');
    }
    await sendIx(
      client,
      connection,
      await client.registry.program.methods
        .initRegistryConfig(admin.publicKey, new BN(30 * 24 * HOUR))
        .accountsStrict({
          admin: admin.publicKey,
          config: client.pda.registryConfig()[0],
          program: programIds.registry,
          programData: programData(programIds.registry),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [admin],
    );
    mint = await createMint(connection, admin, admin.publicKey, null, 6);
    await sendIx(
      client,
      connection,
      await client.escrow.program.methods
        .initConfig(
          mint,
          [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey],
          2,
          {
            minChallengePeriod: new BN(HOUR),
            maxChallengePeriod: new BN(7 * 24 * HOUR),
            minBondBps: 500,
            minBondAbsolute: new BN(1_000_000),
            keeperFeeBps: 50,
            proofTimeoutSecs: new BN(24 * HOUR),
            disputeTimeoutSecs: new BN(3 * 24 * HOUR),
            travelRuleThreshold: new BN(0),
          },
          {
            registryProgram: programIds.registry,
            policyProgram: programIds.policy,
            verifierProgram: programIds.verifier,
          },
        )
        .accountsStrict({
          admin: admin.publicKey,
          config: client.pda.escrowConfig()[0],
          program: programIds.escrow,
          programData: programData(programIds.escrow),
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      [admin],
    );
    for (const wallet of [customer, institution, agentWallet, workerWallet]) {
      await sendIx(
        client,
        connection,
        await client.registry.program.methods
          .recordScreening(wallet.publicKey, { clear: {} }, Array.from(Buffer.alloc(32, 0x5c)))
          .accountsStrict({
            payer: admin.publicKey,
            screenerAuthority: admin.publicKey,
            config: client.pda.registryConfig()[0],
            screeningRecord: client.pda.screeningRecord(wallet.publicKey)[0],
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [admin],
      );
    }
    // Delegasyonun hedefi: zincirde kayıtlı başka bir agent.
    const registered = await client.flow.registerAgent(
      {
        owner: workerWallet.publicKey,
        agentId: 'ceviri-ajani',
        agentCardUri: 'https://worker.localnet.test/.well-known/agent-card.json',
        agentCardHash: Buffer.alloc(32, 7),
        wallet: workerWallet.publicKey,
      },
      { feePayer: workerWallet.publicKey },
    );
    await send(connection, registered, [workerWallet]);
    workerRecord = registered.agentRecord;
    for (const owner of [customer, institution]) {
      const ata = await getOrCreateAssociatedTokenAccount(connection, admin, mint, owner.publicKey);
      await mintTo(connection, admin, mint, ata.address, admin, 50_000_000n);
    }
  }, 300_000);

  afterAll(async () => {
    await hosted?.close();
    await db?.stop();
    if (validator && validator.exitCode === null) {
      const exited = new Promise((resolve) => validator!.once('exit', resolve));
      validator.kill('SIGTERM');
      await exited;
    }
    rmSync(LEDGER, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('yapılandırmadan ayağa kalkar, işi teslim eder; delegasyon politika tavanına uyar', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hosted-localnet-'));
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(Array.from(agentWallet.secretKey)));
    writeFileSync(join(dir, 'kurum.json'), JSON.stringify(Array.from(institution.secretKey)));
    writeFileSync(join(dir, 'policy.yaml'), stringify(policyDocument(mint.toBase58())));
    const base = rawConfig() as { capabilities: Record<string, unknown>[]; agent: Record<string, unknown> };
    writeFileSync(
      join(dir, 'hosted.yaml'),
      stringify(
        rawConfig({
          agent: {
            ...base.agent,
            register: 'self',
            callers: [{ keySha256: sha(CALLER_KEY), institutions: [customer.publicKey.toBase58()] }],
          },
          chain: {
            rpcUrl: `http://127.0.0.1:${RPC_PORT}`,
            commitment: 'confirmed',
            programIds: Object.fromEntries(Object.entries(programIds).map(([k, v]) => [k, v.toBase58()])),
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
            { ...base.capabilities[0], tools: [{ server: 'tools', allow: ['word_count'] }] },
            {
              id: 'research.delegate',
              name: 'Delegasyon',
              description: 'İşi kurumun politikası altında başka bir agent’a verir',
              tags: ['delegation'],
              price: '1000000',
              instructions: 'delegate',
              model: 'claude-opus-5-5',
              delegation: true,
              limits: LIMITS,
            },
          ],
          delegation: {
            policyFile: 'policy.yaml',
            defaultCategory: 'translation',
            allowedAgents: [{ agentRecord: workerRecord.toBase58() }],
            deadlineSecs: 6 * HOUR,
            challengePeriodSecs: HOUR,
            ledgerPath: 'state/ledger.json',
          },
        }),
      ),
    );

    const fake = fakeClaude((params) => {
      const results = lastToolResults(params);
      if (params.system === 'delegate') {
        if (results.length === 0) {
          return toolUse([
            {
              name: 'square_delegate_job',
              input: {
                agentRecord: workerRecord.toBase58(),
                spec: { capability: 'text.upper', input: 'localnet delegasyonu' },
                amount: DELEGATED_AMOUNT.toString(),
              },
            },
            {
              name: 'square_delegate_job',
              input: {
                agentRecord: workerRecord.toBase58(),
                spec: { capability: 'text.upper', input: 'tavan üstü' },
                amount: '6000000',
              },
            },
          ]);
        }
        return text(JSON.stringify(results.map((r) => JSON.parse(r.content as string) as unknown)));
      }
      if (results.length === 0) {
        return toolUse([{ name: 'tools__word_count', input: { text: params.messages[0]!.content as string } }]);
      }
      return text(`kelime sayısı: ${results[0]!.content as string}`);
    });

    const started = await runFromConfig(
      { config: join(dir, 'hosted.yaml'), check: false },
      { SQUARE_API_KEY: 'sqk_test', DATABASE_URL: db!.url, TOOLS_MCP_CALL_LOG: join(dir, 'calls.log') },
      { anthropic: fake.client, extra: { api: api.client() } },
    );
    hosted = started.hosted!;
    const url = `http://127.0.0.1:${(hosted.server!.address() as AddressInfo).port}`;
    const record = await client.registry.fetch('agentRecord', hosted.agent.agentRecord);
    expect(Buffer.from(record!.agentCardHash).toString('hex')).toBe(hosted.agent.cardHash);
    expect(record!.wallet.equals(agentWallet.publicKey)).toBe(true);

    const a2a = createA2aClient({
      url: `${url}/a2a`,
      timeoutMs: 60_000,
      allowInsecureHttp: true,
      headers: { 'x-api-key': CALLER_KEY },
    });
    const now = (await connection.getBlockTime(await connection.getSlot('confirmed')))!;
    const customerAta = await getOrCreateAssociatedTokenAccount(connection, admin, mint, customer.publicKey);
    async function openAndRun(spec: Record<string, unknown>): Promise<{ task: Task; job: PublicKey }> {
      const created = await client.flow.createJob(
        {
          institution: customer.publicKey,
          agentRecord: hosted!.agent.agentRecord,
          spec,
          amount: JOB_AMOUNT,
          deadline: now + 24 * HOUR,
          challengePeriod: BigInt(HOUR),
        },
        { feePayer: customer.publicKey },
      );
      await send(connection, created, [customer]);
      await send(
        connection,
        await client.flow.fundJob(
          { institution: customer.publicKey, job: created.job, institutionTokenAccount: customerAta.address },
          { feePayer: customer.publicKey },
        ),
        [customer],
      );
      const sent = await a2a.sendMessage({
        message: {
          messageId: `localnet-${created.job.toBase58()}`,
          role: 'ROLE_USER',
          parts: [{ data: spec as never, mediaType: 'application/json' }],
          metadata: {
            square: { job: created.job.toBase58(), specHash: Buffer.from(specHashing.specHash(spec)).toString('hex') },
          },
        },
      });
      let task = (sent as { task: Task }).task;
      const deadline = Date.now() + 90_000;
      while (!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(task.status.state)) {
        if (Date.now() > deadline) throw new Error(`görev bitmedi: ${task.status.state}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        task = await a2a.getTask({ id: task.id, historyLength: 20 });
      }
      return { task, job: created.job };
    }

    // 1) MCP tool'lu capability: kabul → Claude + word_count → teslim.
    const echo = await openAndRun({ capability: 'text.echo', input: 'bir iki üç dört', requestId: 'localnet-1' });
    expect(echo.task.status.state, JSON.stringify(echo.task.status)).toBe('TASK_STATE_COMPLETED');
    const onChain = (await client.escrow.fetch('job', echo.job))!;
    expect(Object.keys(onChain.status)).toEqual(['delivered']);
    const upload = api.uploads.find((item) => item.job === echo.job.toBase58())!;
    expect(Buffer.from(upload.content).toString('utf8')).toBe('kelime sayısı: 4');
    expect(Buffer.from(onChain.workHash).toString('hex')).toBe(sha(upload.content));
    expect(
      readFileSync(join(dir, 'calls.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).tool),
    ).toEqual(['word_count']);

    // 2) Delegasyon: izinli tutar gerçek create_job + fund_job; işlem başı tavanı (5) aşan tx'siz reddedilir.
    const institutionAta = await getOrCreateAssociatedTokenAccount(connection, admin, mint, institution.publicKey);
    const before = (await getAccount(connection, institutionAta.address)).amount;
    const delegation = await openAndRun({
      capability: 'research.delegate',
      input: 'dışarı ver',
      requestId: 'localnet-2',
    });
    expect(delegation.task.status.state, JSON.stringify(delegation.task.status)).toBe('TASK_STATE_COMPLETED');
    const report = JSON.parse(Buffer.from(api.uploads.at(-1)!.content).toString('utf8')) as {
      status: string;
      job: string;
      rules?: string[];
    }[];
    expect(report.map((item) => item.status)).toEqual(['funded', 'refused']);
    expect(report[1]!.rules).toEqual(['perTx']);
    const delegated = (await client.escrow.fetch('job', new PublicKey(report[0]!.job)))!;
    expect(Object.keys(delegated.status)).toEqual(['funded']);
    expect(delegated.institution.equals(institution.publicKey)).toBe(true);
    expect(delegated.agentRecord.equals(workerRecord)).toBe(true);
    expect(delegated.amount.toString()).toBe(DELEGATED_AMOUNT.toString());
    expect((await getAccount(connection, institutionAta.address)).amount).toBe(before - DELEGATED_AMOUNT);
    const refusedJob = client.pda.job(
      institution.publicKey,
      specHashing.specHash({ capability: 'text.upper', input: 'tavan üstü' }),
    )[0];
    expect(await client.escrow.fetch('job', refusedJob)).toBeNull();
  }, 240_000);
});
