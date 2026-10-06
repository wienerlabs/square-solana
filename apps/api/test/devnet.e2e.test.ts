// Uyuşmazlık uçtan uca, devnet (BE-22 kabul kriteri): devnet'teki programlar ve escrow config'i, gerçek indexer
// süreci (devnet'i indexler), API bu dosyada. Kurum kanıtı yükler (reasonHash) → `raise_dispute` → indexer aynası →
// arbitrator kuyruğu → iki arbitrator API'nin hazırladığı `resolve_dispute` tx'lerini imzalar → üçüncü oy ön
// denetimde reddedilir → `execute_resolution` → ödeme ve bond agent'a. Son tarih devnet'te 7 gündür; lapse
// senaryosu localnet testindedir (localnet.e2e.test.ts). Yalnızca `DISPUTE_E2E_*` ortamıyla çalışır:
//   DISPUTE_E2E_INSTITUTION   kurum keypair'i (USDC'si, SOL'ü ve temiz screening kaydı var)
//   DISPUTE_E2E_AGENT         agent cüzdanının keypair'i (SOL'ü ve temiz screening kaydı var)
//   DISPUTE_E2E_AGENT_RECORD  cüzdanı DISPUTE_E2E_AGENT olan agent kaydı
//   DISPUTE_E2E_ARBITRATORS   escrow config'indeki üç arbitrator'ın keypair dosyaları (virgülle)
//   DISPUTE_E2E_REPORT        isteğe bağlı: koşunun imzalarının yazılacağı JSON dosyası
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { SQUARE_IDLS, type BuiltTx } from '@squaresdk/solana-sdk';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import { loadOpenApi } from '../src/openapi.js';
import { login } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import type { Wallet } from './fixtures/world.js';

const ENV = {
  institution: process.env['DISPUTE_E2E_INSTITUTION'],
  agent: process.env['DISPUTE_E2E_AGENT'],
  agentRecord: process.env['DISPUTE_E2E_AGENT_RECORD'],
  arbitrators: process.env['DISPUTE_E2E_ARBITRATORS'],
  report: process.env['DISPUTE_E2E_REPORT'],
};
const ENABLED = Boolean(ENV.institution && ENV.agent && ENV.agentRecord && ENV.arbitrators);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** İş tutarı (USDC taban birimi); bond config'in en azı (%10, en az 1 USDC). */
const AMOUNT = 1_000_000n;
const CHALLENGE_PERIOD = 3_600n;
/** Indexer'ın devnet geçmişini indexleyip job'u aynaya yazması için süre. */
const INDEX_TIMEOUT_MS = 900_000;

interface Network {
  rpc: string;
  escrow: { settlementMint: string; params: { minBondBps: number; minBondAbsolute: string } };
}

const load = (path: string): Wallet => {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  return { keypair, address: keypair.publicKey.toBase58() };
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`zaman aşımı: ${what}`);
    await sleep(2_000);
  }
}

describe.skipIf(!ENABLED)('devnet: dispute uçtan uca (kanıt → oylar → execute)', () => {
  let network: Network;
  let stack: Stack;
  let connection: Connection;
  let indexer: ChildProcess | null = null;
  const indexerLog: string[] = [];
  const signatures: Record<string, string> = {};
  let institution: Wallet;
  let agent: Wallet;
  let arbitrators: Wallet[];
  let mint: PublicKey;

  async function send(step: string, built: BuiltTx, signers: Wallet[]): Promise<string> {
    built.transaction.sign(signers.map((signer) => signer.keypair));
    const signature = await connection.sendRawTransaction(built.transaction.serialize());
    const { value } = await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );
    if (value.err) throw new Error(`${step}: ${JSON.stringify(value.err)} (${signature})`);
    signatures[step] = signature;
    return signature;
  }

  const balance = async (owner: PublicKey) =>
    (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner), 'confirmed')).amount;

  beforeAll(async () => {
    network = loadNetwork(ROOT, 'devnet') as Network;
    institution = load(ENV.institution!);
    agent = load(ENV.agent!);
    arbitrators = ENV.arbitrators!.split(',').map((path) => load(path.trim()));
    mint = new PublicKey(network.escrow.settlementMint);
    stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL), rpcUrl: network.rpc });
    connection = new Connection(network.rpc, 'confirmed');
    await truncate(stack.db);
    for (const name of ['registry', 'policy', 'verifier', 'escrow'] as const) {
      await stack.db.program.create({
        data: { name, programId: SQUARE_IDLS[name].address, idlVersion: SQUARE_IDLS[name].metadata.version },
      });
    }
    const [port, metricsPort] = await Promise.all([freePort(), freePort()]);
    indexer = spawn(process.execPath, [join(ROOT, 'apps/indexer/dist/index.js')], {
      env: {
        ...process.env,
        LOG_LEVEL: 'warn',
        HEALTH_CHECK_TIMEOUT_MS: '5000',
        ALERT_EVALUATION_SECONDS: '60',
        DATABASE_URL: inject('databaseUrl'),
        INDEXER_RPC_URLS: network.rpc,
        INDEXER_RPC_TIMEOUT_MS: '30000',
        INDEXER_RPC_COOLDOWN_MS: '2000',
        INDEXER_PORT: String(port),
        INDEXER_METRICS_PORT: String(metricsPort),
        INDEXER_POLL_INTERVAL_MS: '2000',
        INDEXER_SIGNATURE_PAGE_SIZE: '100',
        INDEXER_RECONCILE_INTERVAL_SECONDS: '3600',
        INDEXER_ALERT_STALL_SECONDS: '3600',
        INDEXER_ALERT_LAG_SLOTS: '100000',
        INDEXER_ALERT_DRIFT: '100000',
        INDEXER_ALERT_ERRORS: '100000',
        INDEXER_ALERT_ERROR_WINDOW_SECONDS: '60',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [indexer.stdout!, indexer.stderr!])
      stream.on('data', (chunk) => indexerLog.push(String(chunk)));
  }, 240_000);

  afterAll(async () => {
    if (ENV.report) writeFileSync(ENV.report, `${JSON.stringify(signatures, null, 2)}\n`);
    indexer?.kill('SIGTERM');
    await sleep(2_000);
    if (indexer && indexer.exitCode === null) indexer.kill('SIGKILL');
    await stack?.close();
  });

  it('kanıt → raise → kuyruk → iki oy (API) → üçüncü oy reddi → execute; ödeme ve bond agent’a', async () => {
    const { client } = stack;
    const fee = (who: Wallet) => ({ feePayer: who.keypair.publicKey });
    const agentRecord = new PublicKey(ENV.agentRecord!);
    const institutionAta = getAssociatedTokenAddressSync(mint, institution.keypair.publicKey);
    const label = `be-22 devnet ${Keypair.generate().publicKey.toBase58()}`;

    const created = await client.flow.createJob(
      {
        institution: institution.keypair.publicKey,
        agentRecord,
        spec: { task: label },
        amount: AMOUNT,
        deadline: Math.floor(Date.now() / 1000) + 86_400,
        challengePeriod: CHALLENGE_PERIOD,
      },
      fee(institution),
    );
    await send('create_job', created, [institution]);
    const job = created.job;
    await send(
      'fund_job',
      await client.flow.fundJob(
        { institution: institution.keypair.publicKey, job, institutionTokenAccount: institutionAta },
        fee(institution),
      ),
      [institution],
    );
    await send('accept_job', await client.flow.acceptJob({ agent: agent.keypair.publicKey, job }, fee(agent)), [agent]);
    await send(
      'submit_work',
      await client.flow.submitWork(
        {
          agent: agent.keypair.publicKey,
          job,
          workHash: createHash('sha256').update(label).digest(),
          deliveryUri: 'https://square.example/be-22/devnet',
        },
        fee(agent),
      ),
      [agent],
    );

    // Kanıt yüklemesi job aynasını ister: indexer devnet geçmişini indexleyip teslim edilmiş job'u yazana kadar.
    await until('job aynası', INDEX_TIMEOUT_MS, async () => {
      const row = await stack.db.job.findUnique({ where: { address: job.toBase58() } });
      return row?.status === 'delivered';
    });
    const api = stack.api({ session: await login(stack.api(), institution) });
    const reason = 'Teslimat şartnamenin kabul ölçütlerini karşılamıyor (BE-22 devnet).';
    const evidence = await api.uploadDisputeEvidence(job.toBase58(), new Blob([reason], { type: 'text/plain' }));
    if (!evidence.success) throw new Error(JSON.stringify(evidence.error));
    const { minBondBps, minBondAbsolute } = network.escrow.params;
    const proportional = (AMOUNT * BigInt(minBondBps)) / 10_000n;
    const bond = proportional > BigInt(minBondAbsolute) ? proportional : BigInt(minBondAbsolute);
    await send(
      'raise_dispute',
      await client.flow.raiseDispute(
        {
          institution: institution.keypair.publicKey,
          job,
          reasonHash: Buffer.from(evidence.data.reasonHash, 'hex'),
          bond,
          institutionTokenAccount: institutionAta,
        },
        fee(institution),
      ),
      [institution],
    );

    await until('dispute aynası', INDEX_TIMEOUT_MS, () =>
      stack.db.dispute.findUnique({ where: { job: job.toBase58() } }),
    );
    const listed = await api.listDisputeEvidence(job.toBase58());
    expect(listed.success && listed.data[0]).toMatchObject({ isDisputeReason: true, role: 'institution' });

    const [first, second, third] = arbitrators as [Wallet, Wallet, Wallet];
    const firstApi = stack.api({ session: await login(stack.api(), first) });
    const queue = await firstApi.getArbitrationQueue();
    if (!queue.success) throw new Error(queue.error.message);
    const item = queue.data.find((entry) => entry.dispute.job === job.toBase58())!;
    expect(item).toMatchObject({ hasVoted: false, canVote: true, threshold: 2 });
    expect(item.evidence.map((entry) => entry.reasonHash)).toEqual([evidence.data.reasonHash]);

    for (const [index, arbitrator] of [first, second].entries()) {
      const arbitratorApi = index === 0 ? firstApi : stack.api({ session: await login(stack.api(), arbitrator) });
      const prepared = await arbitratorApi.prepareDisputeVote(job.toBase58(), {
        resolution: { kind: 'favorAgent' },
        feePayer: null,
        computeUnitPrice: null,
      });
      if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.data.transaction, 'base64'));
      tx.sign([arbitrator.keypair]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const { value } = await connection.confirmTransaction(
        { signature, blockhash: prepared.data.blockhash, lastValidBlockHeight: prepared.data.lastValidBlockHeight },
        'confirmed',
      );
      expect(value.err).toBeNull();
      signatures[`resolve_dispute (${arbitrator.address})`] = signature;
    }
    const late = await stack.api({ session: await login(stack.api(), third) }).prepareDisputeVote(job.toBase58(), {
      resolution: { kind: 'favorAgent' },
      feePayer: null,
      computeUnitPrice: null,
    });
    expect(late).toMatchObject({ error: { code: 'conflict' } });
    const decided = await client.escrow.fetch('job', job);
    expect(Object.keys(decided!.status)).toEqual(['resolved']);
    expect(decided!.dispute.approvalCount).toBe(2);

    const agentBefore = await balance(agent.keypair.publicKey);
    await send(
      'execute_resolution',
      await client.flow.executeResolution({ caller: institution.keypair.publicKey, job }, fee(institution)),
      [institution],
    );
    // FavorAgent: escrow ve bond agent tarafına (policy'siz iş; keeper ücreti kesilmez).
    expect((await balance(agent.keypair.publicKey)) - agentBefore).toBe(AMOUNT + bond);
    // Indexer kararı ve kapanışı aynaya yazar.
    const closed = await until('kapanış aynası', INDEX_TIMEOUT_MS, async () => {
      const row = await stack.db.dispute.findUnique({ where: { job: job.toBase58() } });
      return row && row.closedAt > 0n ? row : null;
    });
    expect(closed).toMatchObject({ jobStatus: 'released', approvalCount: 2, lapsed: false });
    expect(closed.decidedAt).toBeGreaterThan(0n);
  }, 1_800_000);
});
