// Uçtan uca devnet koşusu (BE-26 kabul kriteri): Ethereum Sepolia'da yakılan USDC, relayer'ın izlediği transferle
// Solana devnet'te bir job'u fonlar. Yalnızca `CCTP_E2E_*` ortamıyla çalışır (anahtarlar repoda tutulmaz):
//   CCTP_E2E_SEPOLIA_KEY  `{ "privateKey": "0x…" }` dosyası (Sepolia USDC ve ETH)
//   CCTP_E2E_INSTITUTION  kurumun Solana keypair'i (screening'i temiz, SOL'ü var)
//   CCTP_E2E_RELAYER      relayer'ın Solana keypair'i (teslim tx'inin ücreti)
//   CCTP_E2E_AGENT_RECORD job'un agent kaydı (screening'i temiz)
//   CCTP_E2E_REPORT       isteğe bağlı: koşunun imzalarının yazılacağı JSON dosyası
// Ağ, programlar ve ALT'lar `scripts/deploy/networks/devnet.json` ve `Anchor.toml`'dandır. Veritabanı testin kendi
// Postgres konteyneridir. İki senaryo, hızlı kesinlikle:
//   A. Kurumun tek tx'i: relayer attestation'ı izler, kurum mint + fonlamayı tek tx'te imzalar, relayer `funded`.
//   B. Relayer'ın teslimi: kurum beklemeden relayer `receive_message`'ı gönderir (`received`); yarıda kalmış tur
//      canlandırılır (satır `attested`'a geri alınır) ve relayer ikinci kez göndermez; kurum yalnızca fonlamayı
//      imzalar, relayer `funded`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import {
  CCTP_ERC20_ABI,
  cctpApproveCall,
  cctpBurnCall,
  cctpMintRecipient,
  createSquareClient,
  fetchCctpFees,
  type BuiltTx,
  type SquareClient,
} from '@squaresdk/solana-sdk';
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import type { CctpEnvironment } from '../src/environment.js';
import { createFundTxBuilder } from '../src/fund-tx.js';
import { createRegistrar } from '../src/register.js';
import { createCctpRelayer, type CctpRelayer } from '../src/relayer.js';
import { createTransferStore, type TransferRow, type TransferStore } from '../src/store.js';

const ENV = {
  sepoliaKey: process.env['CCTP_E2E_SEPOLIA_KEY'],
  institution: process.env['CCTP_E2E_INSTITUTION'],
  relayer: process.env['CCTP_E2E_RELAYER'],
  agentRecord: process.env['CCTP_E2E_AGENT_RECORD'],
};
const enabled = Object.values(ENV).every((value) => value !== undefined && value !== '');

/** Senaryo başına yakılan tutar (1 USDC) ve kesinlik. */
const AMOUNT = 1_000_000n;
const FINALITY = 'fast' as const;
const POLL_MS = 10_000;
const ATTESTATION_TIMEOUT_MS = 45 * 60_000;
const DEADLINE_SECONDS = 7 * 86_400;

interface Network {
  rpc: string;
  lookupTable: string;
  programs: Record<'registry' | 'policy' | 'verifier' | 'escrow', PublicKey>;
  escrow: { settlementMint: string };
  cctp: {
    attestationApi: string;
    messageTransmitter: string;
    tokenMessengerMinter: string;
    sources: Record<
      string,
      { domain: number; chainId: number; rpc: string; tokenMessenger: Hex; usdc: Hex; lookupTable: string }
    >;
  };
}

const keypair = (path: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!enabled)('CCTP relayer, Sepolia → Solana devnet', () => {
  let db: IsolatedDatabase;
  let store: TransferStore;
  let network: Network;
  let connection: Connection;
  let client: SquareClient;
  let env: CctpEnvironment;
  let institution: Keypair;
  let relayerKey: Keypair;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await startIsolatedDatabase();
    store = createTransferStore(db.client);
    const raw = loadNetwork(fileURLToPath(new URL('../../../', import.meta.url)), 'devnet') as Omit<
      Network,
      'programs'
    > & { programs: Record<string, string> };
    network = {
      ...raw,
      programs: Object.fromEntries(
        Object.entries(raw.programs).map(([name, id]) => [name, new PublicKey(id)]),
      ) as Network['programs'],
    };
    connection = new Connection(network.rpc, 'confirmed');
    client = createSquareClient({ connection, programIds: network.programs, commitment: 'confirmed' });
    const source = network.cctp.sources['sepolia']!;
    env = {
      client,
      connection,
      programs: {
        messageTransmitter: new PublicKey(network.cctp.messageTransmitter),
        tokenMessengerMinter: new PublicKey(network.cctp.tokenMessengerMinter),
      },
      cctpLookupTables: new Map([[source.domain, new PublicKey(source.lookupTable)]]),
      squareLookupTable: new PublicKey(network.lookupTable),
    };
    institution = keypair(ENV.institution!);
    relayerKey = keypair(ENV.relayer!);
  });

  afterAll(async () => {
    const path = process.env['CCTP_E2E_REPORT'];
    if (path) writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    await db?.stop();
  });

  async function send(built: BuiltTx, signers: Keypair[]): Promise<{ signature: string; bytes: number }> {
    built.transaction.sign(signers);
    const bytes = built.transaction.serialize().length;
    const signature = await connection.sendRawTransaction(built.transaction.serialize());
    const result = await connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) throw new Error(`${signature}: ${JSON.stringify(result.value.err)}`);
    return { signature, bytes };
  }

  async function simulatedUnits(tx: VersionedTransaction): Promise<number | null> {
    const simulation = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (simulation.value.err) {
      throw new Error(`simülasyon: ${JSON.stringify(simulation.value.err)} ${simulation.value.logs?.join('\n')}`);
    }
    return simulation.value.unitsConsumed ?? null;
  }

  /** Job: yakılan eksi en fazla ücretle (mint edilen en az bu kadardır). */
  async function createJob(amount: bigint, label: string): Promise<PublicKey> {
    const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
    const built = await client.flow.createJob(
      {
        institution: institution.publicKey,
        agentRecord: new PublicKey(ENV.agentRecord!),
        spec: {
          title: `BE-26 CCTP relayer devnet run (${label})`,
          description: 'USDC burned on Ethereum Sepolia; the relayer tracks the attestation and the funding.',
        },
        amount,
        deadline: Math.floor(Date.now() / 1000) + DEADLINE_SECONDS,
        challengePeriod: BigInt(config!.params.minChallengePeriod.toString()),
      },
      { feePayer: institution.publicKey },
    );
    report[`${label}.createJob`] = (await send(built, [institution])).signature;
    return built.job;
  }

  /** Sepolia'da burn (SDK'nın çağrı tarifleri, viem ile). */
  async function burn(label: string): Promise<{ hash: Hex; maxFee: bigint }> {
    const source = network.cctp.sources['sepolia']!;
    const chain = defineChain({
      id: source.chainId,
      name: 'sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [source.rpc] } },
    });
    const account = privateKeyToAccount(
      (JSON.parse(readFileSync(ENV.sepoliaKey!, 'utf8')) as { privateKey: Hex }).privateKey,
    );
    const reader = createPublicClient({ chain, transport: http(source.rpc) });
    const writer = createWalletClient({ account, chain, transport: http(source.rpc) });
    const call = cctpBurnCall({
      tokenMessenger: source.tokenMessenger,
      burnToken: source.usdc,
      amount: AMOUNT,
      finality: FINALITY,
      mintRecipient: cctpMintRecipient(institution.publicKey, new PublicKey(network.escrow.settlementMint)),
      fees: await fetchCctpFees({ api: network.cctp.attestationApi, sourceDomain: source.domain }),
    });
    const allowance = await reader.readContract({
      address: source.usdc,
      abi: CCTP_ERC20_ABI,
      functionName: 'allowance',
      args: [account.address, source.tokenMessenger],
    });
    if (allowance < AMOUNT) {
      const approve = await writer.writeContract(
        cctpApproveCall({ token: source.usdc, tokenMessenger: source.tokenMessenger, amount: AMOUNT }),
      );
      expect((await reader.waitForTransactionReceipt({ hash: approve })).status).toBe('success');
      report[`${label}.approve`] = approve;
    }
    const hash = await writer.writeContract({
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    });
    expect((await reader.waitForTransactionReceipt({ hash })).status).toBe('success');
    report[`${label}.burn`] = { hash, amount: AMOUNT.toString(), maxFee: call.maxFee.toString(), finality: FINALITY };
    return { hash, maxFee: call.maxFee };
  }

  function relayer(relayAfterSeconds: number): CctpRelayer {
    return createCctpRelayer({
      // Keeper'daki gibi: yalnızca CCTP ALT'ı.
      env: { ...env, squareLookupTable: null },
      store,
      payer: relayerKey,
      attestationApi: network.cctp.attestationApi,
      relayAfterSeconds,
      backoff: { baseSeconds: 5, maxSeconds: 30 },
      batchSize: 10,
      confirmPollMs: 1_000,
      computeUnitPrice: async () => 0n,
    });
  }

  async function until(
    run: CctpRelayer,
    id: string,
    done: (row: TransferRow) => boolean,
    timeoutMs: number,
  ): Promise<TransferRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await run.runOnce();
      const row = (await store.find(id))!;
      if (done(row)) return row;
      if (row.status === 'failed') throw new Error(`transfer failed: ${row.error}`);
      if (Date.now() > deadline) throw new Error(`zaman aşımı: ${row.status} ${row.error ?? ''}`);
      await sleep(POLL_MS);
    }
  }

  async function register(job: PublicKey, hash: Hex) {
    const registrar = createRegistrar({ env, store });
    const request = { sourceDomain: 0, sourceTxHash: hash.toLowerCase(), job: job.toBase58() };
    const first = await registrar.register(institution.publicKey.toBase58(), request);
    // İstemcinin yeniden denemesi aynı satırı döner.
    const again = await registrar.register(institution.publicKey.toBase58(), request);
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, transfer: { id: first.transfer.id } });
    return first.transfer;
  }

  async function expectFunded(job: PublicKey, amount: bigint) {
    const account = await client.escrow.fetch('job', job);
    expect(account && 'funded' in account.status).toBe(true);
    const vault = await connection.getTokenAccountBalance(client.pda.vault(job)[0]);
    expect(BigInt(vault.value.amount)).toBe(amount);
  }

  it(
    'A: kurum mint + fonlamayı tek tx’te imzalar; relayer attestation’ı ve fonlamayı izler',
    async () => {
      const { hash, maxFee } = await burn('A');
      const amount = AMOUNT - maxFee;
      const job = await createJob(amount, 'A');
      const transfer = await register(job, hash);
      // Kurum beklenir: relayer kendisi teslim etmez.
      const run = relayer(3_600);
      const attested = await until(run, transfer.id, (row) => row.status === 'attested', ATTESTATION_TIMEOUT_MS);
      report['A.attestation'] = {
        nonce: attested.nonce,
        amount: attested.amount?.toString(),
        feeExecuted: attested.feeExecuted?.toString(),
      };

      const fund = await createFundTxBuilder({ env, store }).build(institution.publicKey.toBase58(), transfer.id, {
        feePayer: institution.publicKey,
        computeUnitPrice: 0n,
      });
      expect(fund.step).toBe('receiveAndFund');
      const units = await simulatedUnits(fund.built.transaction);
      const sent = await send(fund.built, [institution]);
      report['A.receiveAndFund'] = { ...sent, simulatedUnits: units, computeUnitLimit: fund.computeUnitLimit };

      const funded = await until(run, transfer.id, (row) => row.status === 'funded', 5 * 60_000);
      expect(funded).toMatchObject({ receiveSignature: sent.signature, fundSignature: sent.signature, error: null });
      await expectFunded(job, amount);
      report['A.transfer'] = { id: funded.id, job: job.toBase58(), status: funded.status };
      // Son durumdaki transfere bir daha bakılmaz.
      expect((await run.runOnce()).evaluated).toBe(0);
    },
    60 * 60_000,
  );

  it(
    'B: relayer mesajı kendisi teslim eder; yarıda kalan tur ikinci tx göndermez; kurum yalnızca fonlar',
    async () => {
      const { hash, maxFee } = await burn('B');
      const amount = AMOUNT - maxFee;
      const job = await createJob(amount, 'B');
      const transfer = await register(job, hash);
      const run = relayer(0);
      const received = await until(run, transfer.id, (row) => row.status === 'received', ATTESTATION_TIMEOUT_MS);
      const delivery = await connection.getTransaction(received.receiveSignature!, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      report['B.relayerReceive'] = {
        signature: received.receiveSignature,
        computeUnits: delivery?.meta?.computeUnitsConsumed ?? null,
        feePayer: delivery?.transaction.message.staticAccountKeys[0]?.toBase58(),
      };
      expect(delivery?.transaction.message.staticAccountKeys[0]?.equals(relayerKey.publicKey)).toBe(true);

      // Yarıda kalmış tur: tx gönderildi ama sonuç yazılamadı. Relayer nonce hesabından anlar, yeniden göndermez.
      const balance = await connection.getBalance(relayerKey.publicKey, 'confirmed');
      await store.update(transfer.id, { status: 'attested', receiveSignature: null, attempts: 0, nextAttemptAt: null });
      const replayed = await until(run, transfer.id, (row) => row.status === 'received', 60_000);
      expect(replayed.receiveSignature).toBe(received.receiveSignature);
      expect(await connection.getBalance(relayerKey.publicKey, 'confirmed')).toBe(balance);
      report['B.replay'] = {
        status: replayed.status,
        receiveSignature: replayed.receiveSignature,
        relayerBalanceUnchanged: true,
      };

      const fund = await createFundTxBuilder({ env, store }).build(institution.publicKey.toBase58(), transfer.id, {
        feePayer: institution.publicKey,
        computeUnitPrice: 0n,
      });
      expect(fund.step).toBe('fund');
      const sent = await send(fund.built, [institution]);
      report['B.fund'] = sent;
      const funded = await until(run, transfer.id, (row) => row.status === 'funded', 5 * 60_000);
      expect(funded).toMatchObject({ fundSignature: sent.signature, error: null });
      await expectFunded(job, amount);
      report['B.transfer'] = { id: funded.id, job: job.toBase58(), status: funded.status };
    },
    60 * 60_000,
  );
});
