// BE-27 kabulü gerçek zincirde: devnet'te üç Squads v4 smart account'u (kurum, agent, alıcı) 8 adımı yürütür, her
// tx'in ücretini ve rent'ini fee payer servisi öder. Vault'lar hiç SOL tutmaz; üyeler yalnızca imzalar. Kabul öncesi
// ön-ispat (ADR 0028) ve release ispatı zincirden kurulan witness'larla üretilen gerçek Groth16 ispatlarıdır
// (`@squaresdk/solana-policy`). Yalnızca
// `FEE_PAYER_E2E_*` ortamıyla çalışır (anahtarlar repoda tutulmaz):
//   FEE_PAYER_E2E_SPONSOR   sponsorun keypair'i (SOL'ü var; hiçbir rolde değil)
//   FEE_PAYER_E2E_FUNDER    devnet USDC'si olan cüzdan: vault'ların token hesaplarını açar ve doldurur (kurulum)
//   FEE_PAYER_E2E_SCREENER  `RegistryConfig.screener_authority`: vault'ların screening kaydı (kurulum)
//   FEE_PAYER_E2E_REPORT    isteğe bağlı: koşunun imzalarının yazılacağı JSON dosyası
// Ağ ve programlar `scripts/deploy/networks/devnet.json`'dandır; servisin veritabanı testin Postgres'idir.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SIGNAL,
  buildBuyerTree,
  buildPreflightWitness,
  buildReleaseWitness,
  buildSetComplianceProofTx,
  buildSetPreflightProofTx,
  computePolicyCommitment,
  createLocalProver,
  derivePolicySalts,
  generateLeafSalt,
  generatePolicySecret,
  getBuyerProof,
} from '@squaresdk/solana-policy';
import { createSquareClient, type BuiltTx, type SquareClient } from '@squaresdk/solana-sdk';
import {
  SquadsPermission,
  builtTxInstructions,
  createSmartAccountInstruction,
  readSquadsTreasury,
  wrapInVault,
} from '@squaresdk/solana-sdk/squads';
import type { PolicyDocument } from '@squaresdk/solana-types';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  transfer,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { groth16 } from 'snarkjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- JS betiği; tip bildirimi yok.
import { loadNetwork } from '../../../scripts/deploy/network-config.mjs';
import { PROGRAM_IDS, startStack, truncate, type Stack } from './fixtures/stack.js';
import { encode } from './fixtures/tx.js';

const ENV = {
  sponsor: process.env['FEE_PAYER_E2E_SPONSOR'],
  funder: process.env['FEE_PAYER_E2E_FUNDER'],
  screener: process.env['FEE_PAYER_E2E_SCREENER'],
  report: process.env['FEE_PAYER_E2E_REPORT'],
};
const ENABLED = Boolean(ENV.sponsor && ENV.funder && ENV.screener);

const CIRCUIT = new URL('../../../circuits/payment-compliance/', import.meta.url);
/** İş tutarı ve alacağın fiyatı (USDC taban birimi). */
const AMOUNT = 1_000_000n;
const CLAIM_PRICE = 900_000n;
const CATEGORY = 'research';
const COMPUTE_UNIT_PRICE = 1_000n;
const PROPOSE_UNITS = 200_000;
const EXECUTE_UNITS = 600_000;
const DAY = 86_400;
/** Keeper'a rent'in üstünde verilen pay; finalize'dan sonra yalnızca bu kalmalı (ücret sponsordan). */
const RENT_MARGIN_LAMPORTS = 1_000_000;

interface Network {
  rpc: string;
  escrow: { settlementMint: string; params: { minChallengePeriod: string } };
}

interface Role {
  readonly name: string;
  readonly member: Keypair;
  readonly createKey: Keypair;
  multisig: PublicKey;
  vault: PublicKey;
  next: bigint;
  token: string;
}

const load = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
const role = (name: string): Role => ({
  name,
  member: Keypair.generate(),
  createKey: Keypair.generate(),
  multisig: PublicKey.default,
  vault: PublicKey.default,
  next: 1n,
  token: '',
});

describe.skipIf(!ENABLED)('devnet: Squads smart account ile 8 adım sponsorlu', () => {
  let network: Network;
  let stack: Stack;
  let client: SquareClient;
  let mint: PublicKey;
  const institution = role('institution');
  const agent = role('agent');
  const buyer = role('buyer');
  const keeper = Keypair.generate();
  const signatures: { step: string; signature: string; instructions: string[] }[] = [];
  let keeperFunding = 0;

  /** Servise gönderir (`submit: true`), zincirde onaylanmasını bekler ve kaydeder. */
  async function sponsor(step: string, session: string, built: BuiltTx, signers: Keypair[]): Promise<void> {
    built.transaction.sign(signers);
    const response = await stack.request('POST', '/v1/sponsor', {
      body: { transaction: encode(built.transaction), submit: true },
      headers: { authorization: `Bearer ${session}` },
    });
    expect(response.body.error, `${step}: ${JSON.stringify(response.body.error)}`).toBeNull();
    const signature = response.body.data['signature'] as string;
    const { value } = await stack.connection.confirmTransaction(
      { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
      'confirmed',
    );
    expect(value.err, `${step}: ${signature}`).toBeNull();
    signatures.push({ step, signature, instructions: response.body.data['instructions'] as string[] });
  }

  const options = () => ({ feePayer: stack.sponsor.publicKey, computeUnitPrice: COMPUTE_UNIT_PRICE });
  const ataOf = (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true);
  /** `AgentReputation` ve `ValidationRecord`'un rent'i (IDL'deki hesap boyutlarıyla). */
  const keeperRent = async () => {
    const coder = client.escrow.program.coder.accounts;
    const sizes = ['agentReputation', 'validationRecord'].map((name) => coder.size(name));
    const rents = await Promise.all(sizes.map((size) => stack.connection.getMinimumBalanceForRentExemption(size)));
    return rents.reduce((sum, value) => sum + value, 0);
  };

  /** Rolün vault'u talimatları yürütür: öneri (create + proposal + approve) ve yürütme, ikisi de sponsorlu. */
  async function asVault(step: string, owner: Role, instructions: readonly TransactionInstruction[]): Promise<void> {
    const plan = wrapInVault({
      multisig: owner.multisig,
      transactionIndex: owner.next,
      member: owner.member.publicKey,
      rentPayer: stack.sponsor.publicKey,
      instructions,
    });
    owner.next += 1n;
    const propose = await client.buildTx(plan.propose, { ...options(), computeUnitLimit: PROPOSE_UNITS });
    await sponsor(`${step} (öneri)`, owner.token, propose, [owner.member]);
    const execute = await client.buildTx([plan.execute], { ...options(), computeUnitLimit: EXECUTE_UNITS });
    await sponsor(`${step} (yürütme)`, owner.token, execute, [owner.member]);
  }

  beforeAll(async () => {
    network = loadNetwork(fileURLToPath(new URL('../../../', import.meta.url)), 'devnet') as Network;
    stack = await startStack({ rpcUrl: network.rpc, sponsor: load(ENV.sponsor!) });
    await truncate(stack.db);
    client = createSquareClient({ connection: stack.connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
    mint = new PublicKey(network.escrow.settlementMint);
    for (const owner of [institution, agent, buyer]) owner.token = await stack.session(owner.member.publicKey);
  }, 120_000);

  afterAll(async () => {
    if (ENV.report) writeFileSync(ENV.report, `${JSON.stringify(signatures, null, 2)}\n`);
    await stack?.close();
  });

  it('smart account’lar sponsorla açılır; vault’ların token hesapları ve screening kayıtları hazırlanır', async () => {
    const treasury = await readSquadsTreasury(stack.connection);
    for (const owner of [institution, agent, buyer]) {
      const created = createSmartAccountInstruction({
        createKey: owner.createKey.publicKey,
        creator: stack.sponsor.publicKey,
        members: [{ key: owner.member.publicKey, permissions: SquadsPermission.all }],
        threshold: 1,
        treasury,
      });
      owner.multisig = created.multisig;
      owner.vault = created.vault;
      await sponsor(
        `${owner.name}: smart account`,
        owner.token,
        await client.buildTx([created.instruction], options()),
        [owner.createKey],
      );
    }

    // Kurulum (sponsorsuz): vault'ların ve keeper'ın token hesapları, kurumun ve alıcının USDC'si, screening.
    const funder = load(ENV.funder!);
    const ata = (owner: PublicKey) =>
      getOrCreateAssociatedTokenAccount(stack.connection, funder, mint, owner, true, 'confirmed');
    const funderAccount = await ata(funder.publicKey);
    for (const [owner, amount] of [
      [institution.vault, AMOUNT],
      [buyer.vault, CLAIM_PRICE],
    ] as const) {
      const account = await ata(owner);
      await transfer(stack.connection, funder, funderAccount.address, account.address, funder, amount);
    }
    await ata(agent.vault);
    await ata(keeper.publicKey);
    // finalize_payment'ın açtığı itibar ve doğrulama kayıtlarının rent'ini program keeper'a ödetir (payer = keeper);
    // keeper bunu keeper ücretiyle karşılar. Tx'in ücreti sponsorludur.
    keeperFunding = (await keeperRent()) + RENT_MARGIN_LAMPORTS;
    const funding = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: keeper.publicKey, lamports: keeperFunding }),
    );
    await sendAndConfirmTransaction(stack.connection, funding, [funder], { commitment: 'confirmed' });
    const screener = load(ENV.screener!);
    const sourceHash = Array.from(createHash('sha256').update('be-27 devnet e2e').digest());
    for (const owner of [institution, agent, buyer]) {
      const ix = await client.registry.program.methods
        .recordScreening(owner.vault, { clear: {} }, sourceHash)
        .accountsStrict({
          payer: screener.publicKey,
          screenerAuthority: screener.publicKey,
          config: client.pda.registryConfig()[0],
          screeningRecord: client.pda.screeningRecord(owner.vault)[0],
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      const built = await client.buildTx([ix], { feePayer: screener.publicKey });
      built.transaction.sign([screener]);
      const signature = await stack.connection.sendRawTransaction(built.transaction.serialize());
      await stack.connection.confirmTransaction({ signature, ...built }, 'confirmed');
    }
    for (const owner of [institution, agent, buyer]) {
      expect(await stack.connection.getBalance(owner.vault, 'confirmed')).toBe(0);
    }
  }, 300_000);

  it('8 adım vault imzacılarıyla sponsorlu geçer; ödeme alıcı vault’una gider', async () => {
    const sponsorKey = stack.sponsor.publicKey;
    const institutionPda = client.pda.institution(institution.vault)[0];
    const policyId = Uint8Array.from(createHash('sha256').update(`be-27 policy ${institution.vault}`).digest());
    const policyAddress = client.pda.policy(institutionPda, policyId)[0];
    const policy: PolicyDocument = {
      institution: institutionPda.toBase58(),
      policyId: Buffer.from(policyId).toString('hex'),
      version: 1,
      dailyCeiling: (10n * AMOUNT).toString(),
      maxDaily: (10n * AMOUNT).toString(),
      maxPerTx: (5n * AMOUNT).toString(),
      tokenWhitelist: [mint.toBase58()],
      blockedPayees: [],
      allowedCategories: [CATEGORY],
      timeWindow: null,
    };
    const salts = derivePolicySalts(generatePolicySecret(), policyId);
    const buyers = buildBuyerTree([{ buyer: buyer.vault, leafSalt: generateLeafSalt() }]);
    const policyMethods = client.policy.program.methods;

    // 1. Kurum vault'u: kurum hesabı, politikanın commitment'ı ve onaylı alıcı listesinin kökü.
    await asVault('1. kurum ve politika', institution, [
      await policyMethods
        .initInstitution('BE-27 devnet kurumu')
        .accountsStrict({
          payer: sponsorKey,
          authority: institution.vault,
          institution: institutionPda,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await policyMethods
        .setPolicy(
          Array.from(policyId),
          Array.from(computePolicyCommitment(policy, salts)),
          new BN(policy.dailyCeiling),
        )
        .accountsStrict({
          payer: sponsorKey,
          authority: institution.vault,
          institution: institutionPda,
          policy: policyAddress,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
      await policyMethods
        .setBuyerRoot(Array.from(buyers.root))
        .accountsStrict({ authority: institution.vault, institution: institutionPda, policy: policyAddress })
        .instruction(),
    ]);

    // 2. Agent vault'u kaydın sahibi ve cüzdanı.
    const registered = await client.flow.registerAgent(
      {
        owner: agent.vault,
        agentId: `be27-${agent.vault.toBase58().slice(0, 8)}`,
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: agent.vault,
      },
      options(),
    );
    await asVault('2. agent kaydı', agent, builtTxInstructions(registered));

    // 3. İş açılır ve vault'un USDC'siyle fonlanır.
    const now = (await stack.connection.getBlockTime(await stack.connection.getSlot('confirmed')))!;
    const created = await client.flow.createJob(
      {
        institution: institution.vault,
        agentRecord: registered.agentRecord,
        policy: policyAddress,
        spec: { task: 'BE-27 devnet: smart account ile sponsorlu iş', vault: institution.vault.toBase58() },
        amount: AMOUNT,
        deadline: now + DAY,
        challengePeriod: BigInt(network.escrow.params.minChallengePeriod),
      },
      options(),
    );
    const job = created.job;
    await asVault('3. iş açma', institution, builtTxInstructions(created));
    await asVault(
      '3. fonlama',
      institution,
      builtTxInstructions(
        await client.flow.fundJob(
          { institution: institution.vault, job, institutionTokenAccount: ataOf(institution.vault) },
          options(),
        ),
      ),
    );
    // Kurum vault'u kabulden önce işin kendi koşullarıyla ön-ispatı bağlar (ADR 0028).
    const prover = createLocalProver({
      wasm: new Uint8Array(readFileSync(new URL('build/payment_js/payment.wasm', CIRCUIT))),
      zkey: new Uint8Array(readFileSync(new URL('artifacts/payment.zkey', CIRCUIT))),
      groth16,
    });
    const preflight = await prover.prove(
      await buildPreflightWitness({ client, job, policy, salts, paymentCategory: CATEGORY }),
    );
    expect(BigInt(`0x${preflight.publicInputs[SIGNAL.refusalCode]}`)).toBe(0n);
    await asVault(
      '3. ön-ispat',
      institution,
      builtTxInstructions(
        await buildSetPreflightProofTx(
          client,
          { authority: institution.vault, institution: institutionPda, policy: policyAddress, job, proof: preflight },
          options(),
        ),
      ),
    );

    // 4. Agent vault'u kabul eder ve teslim eder.
    await asVault(
      '4. kabul',
      agent,
      builtTxInstructions(await client.flow.acceptJob({ agent: agent.vault, job }, options())),
    );
    await asVault(
      '4. teslim',
      agent,
      builtTxInstructions(
        await client.flow.submitWork(
          {
            agent: agent.vault,
            job,
            workHash: createHash('sha256').update(`be-27 work ${job}`).digest(),
            deliveryUri: 'https://square.example/be-27/devnet',
          },
          options(),
        ),
      ),
    );

    // 5. Agent alacağı listeler, alıcı vault'u onaylı listedeki kanıtla alır.
    await asVault(
      '5. alacak listeleme',
      agent,
      builtTxInstructions(await client.flow.listClaim({ agent: agent.vault, job, price: CLAIM_PRICE }, options())),
    );
    const membership = getBuyerProof(buyers, buyer.vault);
    await asVault(
      '5. alacak alımı',
      buyer,
      builtTxInstructions(
        await client.flow.buyClaim(
          {
            buyer: buyer.vault,
            job,
            price: CLAIM_PRICE,
            leafSalt: membership.leafSalt,
            merkleProof: membership.merkleProof,
            buyerTokenAccount: ataOf(buyer.vault),
          },
          options(),
        ),
      ),
    );

    // 6–7. İspat zincirden kurulan witness'la üretilir ve kurum vault'uyla bağlanır.
    const witness = await buildReleaseWitness({ client, job, policy, salts, paymentCategory: CATEGORY });
    expect(witness.payee.equals(buyer.vault)).toBe(true);
    const proof = await prover.prove(witness);
    const bound = await buildSetComplianceProofTx(
      client,
      { authority: institution.vault, institution: institutionPda, policy: policyAddress, job, proof },
      options(),
    );
    await asVault('7. ispat', institution, builtTxInstructions(bound));

    // 8. Challenge penceresi kapanınca keeper finalize eder; ücreti sponsor öder.
    const challengeEnd = Number((await client.escrow.fetch('job', job))!.challengeEnd.toString());
    while ((await stack.connection.getBlockTime(await stack.connection.getSlot('confirmed')))! <= challengeEnd) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const finalized = await client.flow.finalizePayment(
      {
        keeper: keeper.publicKey,
        job,
        keeperTokenAccount: ataOf(keeper.publicKey),
      },
      options(),
    );
    await sponsor('8. finalize', await stack.session(keeper.publicKey), finalized, [keeper]);

    const settled = await client.escrow.fetch('job', job);
    expect(Object.keys(settled!.status)).toEqual(['released']);
    const balance = async (owner: PublicKey) => (await getAccount(stack.connection, ataOf(owner), 'confirmed')).amount;
    expect(await balance(buyer.vault)).toBe(witness.netAmount);
    expect(await balance(keeper.publicKey)).toBe(AMOUNT - witness.netAmount);
    expect(await balance(agent.vault)).toBe(CLAIM_PRICE);
    expect(await balance(institution.vault)).toBe(0n);
    for (const owner of [institution, agent, buyer]) {
      expect(await stack.connection.getBalance(owner.vault, 'confirmed')).toBe(0);
    }
    // Keeper'ın SOL'ü yalnızca açılan iki kaydın rent'ine gitti; ücreti sponsor ödedi.
    const records = [client.pda.agentReputation(registered.agentRecord)[0], client.pda.validationRecord(job)[0]];
    let rents = 0;
    for (const address of records) {
      const info = await stack.connection.getAccountInfo(address, 'confirmed');
      rents += await stack.connection.getMinimumBalanceForRentExemption(info!.data.length);
    }
    expect(await stack.connection.getBalance(keeper.publicKey, 'confirmed')).toBe(keeperFunding - rents);
    const rows = await stack.db.sponsoredTx.findMany();
    expect(rows.every((row) => row.status === 'submitted')).toBe(true);
    expect(rows).toHaveLength(signatures.length);
  }, 900_000);
});
