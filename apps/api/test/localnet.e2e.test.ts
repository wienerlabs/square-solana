// Uyuşmazlık uçtan uca, localnet (BE-22): gerçek programlar `solana-test-validator`'da, gerçek indexer ve keeper
// süreçleri, API bu dosyada. `SQUARE_LOCALNET=1` ile çalışır; yoksa atlanır (CI'da validator yok).
//   A. Kurum kanıtı yükler (reasonHash) → `raise_dispute` → indexer aynası → arbitrator kuyruğu → iki arbitrator
//      API'nin hazırladığı `resolve_dispute` tx'lerini imzalar → `execute_resolution` → ödeme ve bond agent'a.
//   B. `raise_dispute` → son tarih geçer → keeper'ın lapse crank'i `lapse_dispute` gönderir → bond kuruma döner,
//      iş `Delivered`'a döner, günlükte `confirmed`.
// Ortam:
//   SQUARE_PROGRAMS_DIR   derlenmiş programlar (varsayılan <repo>/target/deploy)
//   SQUARE_LOCALNET_RPC_PORT, SQUARE_LOCALNET_ARGS (ek validator argümanları, ör. port aralıkları),
//   SQUARE_LOCALNET_LEDGER (varsayılan geçici dizin)
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BN } from '@anchor-lang/core';
import { createMint, getOrCreateAssociatedTokenAccount, getAccount, mintTo } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { SQUARE_IDLS, type BuiltTx } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { login } from './fixtures/login.js';
import { PROGRAM_IDS, PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import type { Wallet } from './fixtures/world.js';

const ENABLED = process.env['SQUARE_LOCALNET'] === '1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROGRAMS_DIR = process.env['SQUARE_PROGRAMS_DIR'] ?? join(ROOT, 'target/deploy');
const RPC_PORT = Number(process.env['SQUARE_LOCALNET_RPC_PORT'] ?? 8899);
const EXTRA_ARGS = (process.env['SQUARE_LOCALNET_ARGS'] ?? '').split(/\s+/).filter(Boolean);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** Dispute son tarihi: indexer'ın kesinleşmiş aynası (~15 sn) ve iki oy sığar. */
const DISPUTE_TIMEOUT_SECS = 60;
const AMOUNT = 10_000_000n;
const BOND = 1_000_000n;

const wallet = (): Wallet => {
  const keypair = Keypair.generate();
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
    await sleep(500);
  }
}

describe.skipIf(!ENABLED)('localnet: dispute uçtan uca', () => {
  const processes: ChildProcess[] = [];
  const logs: Record<string, string[]> = { validator: [], indexer: [], keeper: [] };
  let ledger: string;
  let connection: Connection;
  let stack: Stack;
  const admin = wallet();
  const screener = wallet();
  const institution = wallet();
  const agentOwner = wallet();
  const agentWallet = wallet();
  const keeper = wallet();
  const panel = [wallet(), wallet(), wallet()];
  let mint: PublicKey;
  let institutionAta: PublicKey;
  let agentRecord: PublicKey;

  const run = (name: string, command: string, args: string[], env: Record<string, string> = {}) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer) => logs[name]!.push(chunk.toString());
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    processes.push(child);
    return child;
  };

  async function send(instructions: readonly TransactionInstruction[] | BuiltTx, signers: Keypair[]) {
    const built = Array.isArray(instructions)
      ? await stack.client.buildTx(instructions as TransactionInstruction[], { feePayer: signers[0]!.publicKey })
      : (instructions as BuiltTx);
    built.transaction.sign(signers);
    const signature = await connection.sendRawTransaction(built.transaction.serialize());
    const result = await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) throw new Error(`tx başarısız: ${JSON.stringify(result.value.err)}`);
    return signature;
  }

  const programData = (program: PublicKey) =>
    PublicKey.findProgramAddressSync([program.toBuffer()], BPF_UPGRADEABLE)[0];

  beforeAll(async () => {
    ledger = process.env['SQUARE_LOCALNET_LEDGER'] ?? mkdtempSync(join(tmpdir(), 'square-localnet-'));
    const adminFile = join(mkdtempSync(join(tmpdir(), 'square-admin-')), 'admin.json');
    writeFileSync(adminFile, JSON.stringify(Array.from(admin.keypair.secretKey)));
    const programs = (['registry', 'policy', 'verifier', 'escrow'] as const).flatMap((name) => [
      '--upgradeable-program',
      SQUARE_IDLS[name].address,
      join(PROGRAMS_DIR, `square_${name}.so`),
      adminFile,
    ]);
    run('validator', 'solana-test-validator', [
      '--reset',
      '--quiet',
      '--ledger',
      ledger,
      '--rpc-port',
      String(RPC_PORT),
      ...EXTRA_ARGS,
      ...programs,
    ]);
    connection = new Connection(RPC_URL, 'confirmed');
    await until('validator', 90_000, async () => {
      try {
        return (await connection.getSlot()) > 1;
      } catch {
        return false;
      }
    });
    for (const who of [admin, screener, institution, agentOwner, agentWallet, keeper, ...panel]) {
      const signature = await connection.requestAirdrop(who.keypair.publicKey, 10 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(signature, 'confirmed');
    }

    stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL), rpcUrl: RPC_URL });
    await truncate(stack.db);
    for (const name of ['registry', 'policy', 'verifier', 'escrow'] as const) {
      await stack.db.program.create({
        data: { name, programId: SQUARE_IDLS[name].address, idlVersion: SQUARE_IDLS[name].metadata.version },
      });
    }

    // Registry config, settlement mint, escrow config (3 arbitrator, M = 2).
    const { client } = stack;
    await send(
      [
        await client.registry.instructions.initRegistryConfig([screener.keypair.publicKey, new BN(30 * 86_400)], {
          admin: admin.keypair.publicKey,
          programData: programData(PROGRAM_IDS.registry),
        }),
      ],
      [admin.keypair],
    );
    mint = await createMint(connection, admin.keypair, admin.keypair.publicKey, null, 6);
    await send(
      [
        await client.escrow.instructions.initConfig(
          [
            mint,
            panel.map((p) => p.keypair.publicKey),
            2,
            {
              minChallengePeriod: new BN(1),
              maxChallengePeriod: new BN(86_400),
              minBondBps: 0,
              minBondAbsolute: new BN(1),
              keeperFeeBps: 50,
              proofTimeoutSecs: new BN(0),
              disputeTimeoutSecs: new BN(DISPUTE_TIMEOUT_SECS),
              travelRuleThreshold: new BN(0),
            },
            {
              registryProgram: PROGRAM_IDS.registry,
              policyProgram: PROGRAM_IDS.policy,
              verifierProgram: PROGRAM_IDS.verifier,
            },
          ],
          { admin: admin.keypair.publicKey, programData: programData(PROGRAM_IDS.escrow) },
        ),
      ],
      [admin.keypair],
    );
    institutionAta = (
      await getOrCreateAssociatedTokenAccount(connection, admin.keypair, mint, institution.keypair.publicKey)
    ).address;
    await mintTo(connection, admin.keypair, mint, institutionAta, admin.keypair, 1_000_000_000n);

    // Agent kaydı ve iki tarafın screening'i.
    const registered = await client.flow.registerAgent(
      {
        owner: agentOwner.keypair.publicKey,
        agentId: 'dispute-e2e',
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: agentWallet.keypair.publicKey,
      },
      { feePayer: agentOwner.keypair.publicKey },
    );
    agentRecord = registered.agentRecord;
    await send(registered, [agentOwner.keypair]);
    for (const subject of [institution, agentWallet]) {
      await send(
        [
          await client.registry.instructions.recordScreening(
            [subject.keypair.publicKey, { clear: {} }, Array.from({ length: 32 }, () => 7)],
            { payer: screener.keypair.publicKey, screenerAuthority: screener.keypair.publicKey },
          ),
        ],
        [screener.keypair],
      );
    }

    // Indexer ve keeper gerçek süreçler olarak; veritabanı API testleriyle aynı.
    const observability = { LOG_LEVEL: 'warn', HEALTH_CHECK_TIMEOUT_MS: '2000', ALERT_EVALUATION_SECONDS: '60' };
    const [indexerPort, indexerMetrics, keeperPort, keeperMetrics] = await Promise.all([
      freePort(),
      freePort(),
      freePort(),
      freePort(),
    ]);
    run('indexer', process.execPath, [join(ROOT, 'apps/indexer/dist/index.js')], {
      ...observability,
      DATABASE_URL: inject('databaseUrl'),
      INDEXER_RPC_URLS: RPC_URL,
      INDEXER_RPC_TIMEOUT_MS: '10000',
      INDEXER_RPC_COOLDOWN_MS: '1000',
      INDEXER_PORT: String(indexerPort),
      INDEXER_METRICS_PORT: String(indexerMetrics),
      INDEXER_POLL_INTERVAL_MS: '500',
      INDEXER_SIGNATURE_PAGE_SIZE: '100',
      INDEXER_RECONCILE_INTERVAL_SECONDS: '3600',
      INDEXER_ALERT_STALL_SECONDS: '600',
      INDEXER_ALERT_DRIFT: '1000',
      INDEXER_ALERT_ERRORS: '1000',
      INDEXER_ALERT_ERROR_WINDOW_SECONDS: '60',
    });
    run('keeper', process.execPath, [join(ROOT, 'apps/keeper/dist/index.js')], {
      ...observability,
      LOG_LEVEL: 'info',
      DATABASE_URL: inject('databaseUrl'),
      KEEPER_RPC_URLS: RPC_URL,
      KEEPER_RPC_TIMEOUT_MS: '10000',
      KEEPER_RPC_COOLDOWN_MS: '1000',
      KEEPER_SECRET_KEY: bs58.encode(keeper.keypair.secretKey),
      KEEPER_PORT: String(keeperPort),
      KEEPER_METRICS_PORT: String(keeperMetrics),
      KEEPER_POLL_INTERVAL_MS: '1000',
      KEEPER_CONFIRM_POLL_MS: '250',
      KEEPER_BATCH_SIZE: '20',
      KEEPER_BACKOFF_BASE_SECONDS: '2',
      KEEPER_BACKOFF_MAX_SECONDS: '10',
      KEEPER_MINT_UNITS_PER_SOL: '150000000',
      KEEPER_MIN_MARGIN_BPS: '0',
      KEEPER_PRIORITY_FEE_PERCENTILE: '50',
      KEEPER_MAX_COMPUTE_UNIT_PRICE: '1000',
      KEEPER_ALERT_MIN_BALANCE_LAMPORTS: '1',
      KEEPER_ALERT_STALL_SECONDS: '600',
      KEEPER_ALERT_ERRORS: '1000',
      KEEPER_ALERT_ERROR_WINDOW_SECONDS: '60',
    });
  }, 240_000);

  afterAll(async () => {
    for (const child of processes.reverse()) child.kill('SIGTERM');
    await sleep(2_000);
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
    await stack?.close();
    if (!process.env['SQUARE_LOCALNET_LEDGER']) rmSync(ledger, { recursive: true, force: true });
  });

  /** Fonlanmış, kabul edilmiş ve teslim edilmiş iş (challenge penceresi açık). */
  async function deliveredJob(label: string) {
    const { client } = stack;
    const created = await client.flow.createJob(
      {
        institution: institution.keypair.publicKey,
        agentRecord,
        spec: { task: label, nonce: Keypair.generate().publicKey.toBase58() },
        amount: AMOUNT,
        deadline: Math.floor(Date.now() / 1000) + 86_400,
        challengePeriod: 3_600n,
      },
      { feePayer: institution.keypair.publicKey },
    );
    await send(created, [institution.keypair]);
    const job = created.job;
    await send(
      await client.flow.fundJob(
        { institution: institution.keypair.publicKey, job, institutionTokenAccount: institutionAta },
        { feePayer: institution.keypair.publicKey },
      ),
      [institution.keypair],
    );
    await send(
      await client.flow.acceptJob(
        { agent: agentWallet.keypair.publicKey, job },
        { feePayer: agentWallet.keypair.publicKey },
      ),
      [agentWallet.keypair],
    );
    await send(
      await client.flow.submitWork(
        {
          agent: agentWallet.keypair.publicKey,
          job,
          workHash: createHash('sha256').update(label).digest(),
          deliveryUri: `https://files.square.test/${label}`,
        },
        { feePayer: agentWallet.keypair.publicKey },
      ),
      [agentWallet.keypair],
    );
    return job;
  }

  async function raise(job: PublicKey, reasonHash: Uint8Array) {
    await send(
      await stack.client.flow.raiseDispute(
        {
          institution: institution.keypair.publicKey,
          job,
          reasonHash,
          bond: BOND,
          institutionTokenAccount: institutionAta,
        },
        { feePayer: institution.keypair.publicKey },
      ),
      [institution.keypair],
    );
  }

  const balance = async (owner: PublicKey) => {
    const ata = await getOrCreateAssociatedTokenAccount(connection, admin.keypair, mint, owner);
    return (await getAccount(connection, ata.address, 'confirmed')).amount;
  };

  it('A: kanıt → raise → kuyruk → iki oy (API) → execute; B: raise → son tarih → keeper lapse', async () => {
    const { client } = stack;
    const api = stack.api({ session: await login(stack.api(), institution) });
    const jobA = await deliveredJob('job-a');
    const jobB = await deliveredJob('job-b');

    // Kurum gerekçesini yükler; dönen hash raise_dispute'un argümanıdır. Yükleme job aynasını ister: indexer
    // teslim edilmiş job'u yazana kadar beklenir.
    await until('job aynası', 90_000, async () => {
      const row = await stack.db.job.findUnique({ where: { address: jobA.toBase58() } });
      return row?.status === 'delivered';
    });
    const reason = 'Teslimat şartnamedeki 3 maddeyi karşılamıyor.';
    const evidence = await api.uploadDisputeEvidence(jobA.toBase58(), new Blob([reason], { type: 'text/plain' }));
    if (!evidence.success) throw new Error(JSON.stringify(evidence.error));
    await raise(jobA, Buffer.from(evidence.data.reasonHash, 'hex'));
    await raise(jobB, createHash('sha256').update('job-b gerekçesi').digest());
    const raisedAt = Date.now();

    // Indexer kesinleşmiş tx'lerden dispute aynasını yazar.
    await until('dispute aynası', 90_000, () => stack.db.dispute.findUnique({ where: { job: jobA.toBase58() } }));
    const listed = await api.listDisputeEvidence(jobA.toBase58());
    expect(listed.success && listed.data[0]).toMatchObject({ isDisputeReason: true, role: 'institution' });

    const [first, second] = [panel[0]!, panel[1]!];
    const firstApi = stack.api({ session: await login(stack.api(), first) });
    const queue = await firstApi.getArbitrationQueue();
    if (!queue.success) throw new Error(queue.error.message);
    const item = queue.data.find((entry) => entry.dispute.job === jobA.toBase58())!;
    expect(item).toMatchObject({ hasVoted: false, canVote: true, threshold: 2 });
    expect(item.evidence.map((e) => e.reasonHash)).toEqual([evidence.data.reasonHash]);

    for (const arbitrator of [first, second]) {
      const arbitratorApi =
        arbitrator === first ? firstApi : stack.api({ session: await login(stack.api(), arbitrator) });
      const prepared = await arbitratorApi.prepareDisputeVote(jobA.toBase58(), {
        resolution: { kind: 'favorAgent' },
        feePayer: null,
        computeUnitPrice: null,
      });
      if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.data.transaction, 'base64'));
      tx.sign([arbitrator.keypair]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      const confirmed = await connection.confirmTransaction(
        { signature, blockhash: prepared.data.blockhash, lastValidBlockHeight: prepared.data.lastValidBlockHeight },
        'confirmed',
      );
      expect(confirmed.value.err).toBeNull();
    }
    // Karar verildi: üçüncü oy ön denetimde reddedilir.
    const third = await stack
      .api({ session: await login(stack.api(), panel[2]!) })
      .prepareDisputeVote(jobA.toBase58(), {
        resolution: { kind: 'favorAgent' },
        feePayer: null,
        computeUnitPrice: null,
      });
    expect(third).toMatchObject({ error: { code: 'conflict' } });
    const decided = await client.escrow.fetch('job', jobA);
    expect(Object.keys(decided!.status)).toEqual(['resolved']);
    expect(decided!.dispute.approvalCount).toBe(2);

    const agentBefore = await balance(agentWallet.keypair.publicKey);
    await send(
      await client.flow.executeResolution(
        { caller: admin.keypair.publicKey, job: jobA },
        { feePayer: admin.keypair.publicKey },
      ),
      [admin.keypair],
    );
    // FavorAgent: escrow ve bond agent tarafına (policy'siz iş; keeper ücreti kesilmez).
    expect((await balance(agentWallet.keypair.publicKey)) - agentBefore).toBe(AMOUNT + BOND);

    // B: son tarih geçince keeper lapse eder; bond kuruma döner.
    const institutionBefore = await balance(institution.keypair.publicKey);
    const lapse = await until('keeper lapse', (DISPUTE_TIMEOUT_SECS + 120) * 1000, () =>
      stack.db.keeperAction.findFirst({
        where: { job: jobB.toBase58(), action: 'lapseDispute', outcome: 'confirmed' },
      }),
    );
    expect(Date.now() - raisedAt).toBeGreaterThanOrEqual((DISPUTE_TIMEOUT_SECS - 5) * 1000);
    expect(lapse.signature).toBeTruthy();
    const lapsed = await client.escrow.fetch('job', jobB);
    expect(Object.keys(lapsed!.status)).toEqual(['delivered']);
    expect(lapsed!.dispute.lapsed).toBe(true);
    expect((await balance(institution.keypair.publicKey)) - institutionBefore).toBe(BOND);
    // Indexer lapse'ı aynaya yazar.
    const mirrored = await until('lapse aynası', 90_000, async () => {
      const row = await stack.db.dispute.findUnique({ where: { job: jobB.toBase58() } });
      return row?.lapsed ? row : null;
    });
    expect(mirrored.jobStatus).toBe('delivered');
  }, 600_000);
});
