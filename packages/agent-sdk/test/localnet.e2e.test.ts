// Localnet kabul testi (BE-19): gerçek `solana-test-validator`'da derlenmiş dört Square programıyla agent
// kaydı → job → A2A görevi → accept_job → teslimat → submit_work → list_claim. Yalnızca SQUARE_LOCALNET=1 ile
// koşar; programlar `anchor build` çıktısıdır (`SQUARE_DEPLOY_DIR`, varsayılan repo kökündeki target/deploy).
// Teslimat Square API'sinin sözleşmesindeki uca gider; API'nin kendisi (apps/api) indexer ve Postgres ister,
// burada `createApiClient`'a verilen sahte fetch kullanılır (test/helpers/harness.ts FakeApi).
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BN } from '@anchor-lang/core';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import { createA2aClient, createApiKeyAuthenticator } from '@squaresdk/solana-a2a';
import { createPrismaTaskStore } from '@squaresdk/solana-a2a/prisma';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { createSquareClient, SQUARE_IDLS, specHashing, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import type { Task } from '@squaresdk/solana-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { textStatsCapability, textStatsHandler, type TextStats } from '../examples/text-stats-agent.js';
import { createAgent } from '../src/agent.js';
import type { Agent, ClaimListing } from '../src/types.js';
import { API_KEY, API_URL, FakeApi } from './helpers/harness.js';

const ENABLED = process.env.SQUARE_LOCALNET === '1';
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DEPLOY_DIR = process.env.SQUARE_DEPLOY_DIR ?? join(REPO_ROOT, 'target', 'deploy');
const RPC_PORT = Number(process.env.SQUARE_LOCALNET_RPC_PORT ?? 18_899);
const LEDGER = process.env.SQUARE_LOCALNET_LEDGER ?? join(tmpdir(), `square-agent-sdk-ledger-${process.pid}`);
const CALLER_KEY = 'localnet-kurum-anahtari';
/** 6 ondalıklı settlement mint; 25 birim. */
const AMOUNT = 25_000_000n;
const HOUR = 3_600;

const PROGRAMS = {
  registry: { id: SQUARE_IDLS.registry.address, so: 'square_registry.so' },
  policy: { id: SQUARE_IDLS.policy.address, so: 'square_policy.so' },
  verifier: { id: SQUARE_IDLS.verifier.address, so: 'square_verifier.so' },
  escrow: { id: SQUARE_IDLS.escrow.address, so: 'square_escrow.so' },
};

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
/** Yükseltilebilir yükleyici (BPFLoaderUpgradeab1e…); ProgramData PDA'sı onun altında. */
const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const programData = (program: PublicKey) =>
  PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

let validator: ChildProcess | null = null;
let db: IsolatedDatabase | null = null;
let agent: Agent | null = null;

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

describe.skipIf(!ENABLED)('localnet: agent kaydı → job → kabul → teslim → alacak', () => {
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
  const institution = Keypair.generate();
  const api = new FakeApi();
  let mint: PublicKey;

  beforeAll(async () => {
    for (const { so } of Object.values(PROGRAMS)) {
      if (!existsSync(join(DEPLOY_DIR, so)))
        throw new Error(`${join(DEPLOY_DIR, so)} yok: anchor build ya da SQUARE_DEPLOY_DIR`);
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

    for (const key of [admin, agentWallet, institution]) {
      const signature = await connection.requestAirdrop(key.publicKey, 20 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, 'confirmed');
    }

    // Registry config'i (screener = admin) ve escrow config'i; admin programların yükseltme yetkilisi.
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
    for (const wallet of [institution.publicKey, agentWallet.publicKey]) {
      await sendIx(
        client,
        connection,
        await client.registry.program.methods
          .recordScreening(wallet, { clear: {} }, Array.from(Buffer.alloc(32, 0x5c)))
          .accountsStrict({
            payer: admin.publicKey,
            screenerAuthority: admin.publicKey,
            config: client.pda.registryConfig()[0],
            screeningRecord: client.pda.screeningRecord(wallet)[0],
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        [admin],
      );
    }
  }, 240_000);

  afterAll(async () => {
    await agent?.close();
    await db?.stop();
    if (validator && validator.exitCode === null) {
      const exited = new Promise((resolve) => validator!.once('exit', resolve));
      validator.kill('SIGTERM');
      await exited;
    }
    rmSync(LEDGER, { recursive: true, force: true });
  });

  it('örnek agent kaydolur, job’u A2A ile alır, zincirde kabul edip teslim eder ve alacağı listeler', async () => {
    const listed: ClaimListing[] = [];
    agent = await createAgent({
      name: 'Metin Ajanı',
      description: 'Localnet kabul testi',
      version: '1.0.0',
      publicUrl: 'https://metin-ajani.localnet.test',
      agentId: 'metin-ajani',
      capabilities: [textStatsCapability(10_000_000n)],
      handler: textStatsHandler,
      signer: agentWallet,
      connection,
      programIds,
      api: { baseUrl: API_URL, apiKey: API_KEY, fetch: api.fetch },
      store: createPrismaTaskStore(db!.client),
      authenticate: createApiKeyAuthenticator({
        keys: [{ keySha256: sha(CALLER_KEY), institutions: [institution.publicKey.toBase58()] }],
      }),
      autoListClaim: { discountBps: 300 },
      onClaimListed: (listing) => listed.push(listing),
    });

    // Adım 2: kayıt (kart agent'ın well-known yolunda).
    const registration = await agent.register();
    expect(registration.status).toBe('registered');
    const record = await client.registry.fetch('agentRecord', agent.agentRecord);
    expect(record!.agentCardUri).toBe(agent.cardUrl);
    expect(Buffer.from(record!.agentCardHash).toString('hex')).toBe(agent.cardHash);
    expect(record!.wallet.equals(agentWallet.publicKey)).toBe(true);
    expect((await agent.register()).status).toBe('unchanged');

    const server = await agent.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const served = new Uint8Array(await (await fetch(`${url}/.well-known/agent-card.json`)).arrayBuffer());
    expect(sha(served)).toBe(Buffer.from(record!.agentCardHash).toString('hex'));

    // Adım 3: kurum job'u açar ve fonlar.
    const spec = {
      capability: 'text.stats',
      input: 'Square ajanları işi zincirde kabul eder. Teslimat hash ile taahhüt edilir! Ödeme escrow’dan çıkar.',
      requestId: Keypair.generate().publicKey.toBase58(),
    };
    const institutionAta = await getOrCreateAssociatedTokenAccount(connection, admin, mint, institution.publicKey);
    await mintTo(connection, admin, mint, institutionAta.address, admin, AMOUNT);
    const slot = await connection.getSlot('confirmed');
    const now = (await connection.getBlockTime(slot))!;
    const created = await client.flow.createJob(
      {
        institution: institution.publicKey,
        agentRecord: agent.agentRecord,
        spec,
        amount: AMOUNT,
        deadline: now + 24 * HOUR,
        challengePeriod: BigInt(HOUR),
      },
      { feePayer: institution.publicKey },
    );
    await send(connection, created, [institution]);
    const job = created.job;
    await send(
      connection,
      await client.flow.fundJob(
        { institution: institution.publicKey, job, institutionTokenAccount: institutionAta.address },
        { feePayer: institution.publicKey },
      ),
      [institution],
    );

    // Adım 4: kurumun agent'ı işi A2A ile gönderir.
    const a2a = createA2aClient({
      url: `${url}/a2a`,
      timeoutMs: 60_000,
      allowInsecureHttp: true,
      headers: { 'x-api-key': CALLER_KEY },
    });
    const sent = await a2a.sendMessage({
      message: {
        messageId: `localnet-${job.toBase58()}`,
        role: 'ROLE_USER',
        parts: [{ data: spec, mediaType: 'application/json' }],
        metadata: {
          square: { job: job.toBase58(), specHash: Buffer.from(specHashing.specHash(spec)).toString('hex') },
        },
      },
    });
    let task = (sent as { task: Task }).task;
    const deadline = Date.now() + 60_000;
    while (!['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(task.status.state)) {
      if (Date.now() > deadline) throw new Error(`görev bitmedi: ${task.status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      task = await a2a.getTask({ id: task.id, historyLength: 20 });
    }
    expect(task.status.state, JSON.stringify(task.status)).toBe('TASK_STATE_COMPLETED');

    // Zincirde: job teslim edildi, workHash teslimatın SHA-256'sı, URI makbuzdaki.
    const onChain = (await client.escrow.fetch('job', job))!;
    expect(Object.keys(onChain.status)).toEqual(['delivered']);
    const upload = api.uploads.at(-1)!;
    expect(Buffer.from(onChain.workHash).toString('hex')).toBe(sha(upload.content));
    expect(onChain.deliveryUri).toBe(upload.receipt.deliveryUri);
    const stats = JSON.parse(Buffer.from(upload.content).toString('utf8')) as TextStats;
    expect(stats).toMatchObject({ job: job.toBase58(), words: 14, sentences: 3 });
    expect(stats.inputSha256).toBe(sha(spec.input));

    // Adım 5: alacak %3 indirimle listelendi.
    const deadlineList = Date.now() + 30_000;
    while (listed.length === 0 && Date.now() < deadlineList) await new Promise((r) => setTimeout(r, 200));
    const listing = await client.escrow.fetch('claimListing', client.pda.claimListing(job)[0]);
    expect(listing!.price.toString()).toBe(((AMOUNT * 9_700n) / 10_000n).toString());
    expect(listing!.seller.equals(agentWallet.publicKey)).toBe(true);
    expect(Object.keys(listing!.status)).toEqual(['listed']);
  }, 180_000);
});
