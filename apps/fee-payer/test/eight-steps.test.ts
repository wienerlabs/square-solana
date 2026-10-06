// BE-27 kabulü: smart account (Squads v4 vault) ile 8 adımın her tx'i sponsorlu geçer. Model BC-35 testleridir
// (tests/programs/tests/squads.rs): kurum, agent ve alıcı rolleri Squads vault PDA'larıdır, ücreti ve rent'i
// rolü olmayan sponsor öder. Talimatlar SDK akışıyla (`flow`) ve IDL builder'larıyla üretilir, SDK'nın Squads
// yardımcılarıyla (`wrapInVault`) vault tx'ine sarılır; her adım iki tx'tir (öneri: create + proposal +
// approve; yürütme: execute) ve ikisi de üyenin imzasıyla servise gönderilir. Zincir fixture RPC'dir: SDK'nın
// okuduğu hesaplar IDL coder'ıyla yazılır, öneri işleminin bıraktığı VaultTransaction hesabı yürütmeden önce
// eklenir. Gerçek zincirdeki 8 adım zincir tarafında LiteSVM ile kanıtlıdır (BC-35).
import type { BN, Idl, Program } from '@anchor-lang/core';
import { createSquareClient, specHashing, type SquareClient } from '@squaresdk/solana-sdk';
import { builtTxInstructions, squadsVaultAddress, wrapInVault } from '@squaresdk/solana-sdk/squads';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  SystemProgram,
  type PublicKey,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import BigNumber from 'bn.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSampler } from './fixtures/idl-sample.js';
import { vaultTransactionData } from './fixtures/squads.js';
import { PROGRAM_IDS, startStack, truncate, type Stack } from './fixtures/stack.js';
import { encode, key } from './fixtures/tx.js';

let stack: Stack;
let client: SquareClient;

interface Party {
  readonly member: Keypair;
  readonly multisig: PublicKey;
  readonly vault: PublicKey;
  next: bigint;
  token: string;
}

const party = (): Party => {
  const multisig = key();
  return { member: Keypair.generate(), multisig, vault: squadsVaultAddress(multisig, 0)[0], next: 1n, token: '' };
};

const institution = party();
const agent = party();
const buyer = party();
const keeper = Keypair.generate();
const mint = key();
const spec = { task: 'squads sponsorlu iş', version: 1 };
const specHash = specHashing.specHash(spec);
const policyId = new Uint8Array(32).fill(0x21);
/** Her işlemin compute budget'ı (öneri ve yürütme); fiyat tavanın altında. */
const PROPOSE_UNITS = 200_000;
const EXECUTE_UNITS = 600_000;
const PRICE = 1_000n;

const accepted: string[][] = [];

async function setProgramAccount(
  program: Program<Idl>,
  name: string,
  address: PublicKey,
  data: Record<string, unknown>,
) {
  stack.rpc.setAccount(address, {
    owner: program.programId.toBase58(),
    data: await program.coder.accounts.encode(name, data),
  });
}

/** Rolün vault'u talimatları vault tx'ine sarar; öneri ve yürütme sponsorlu gönderilir. */
async function asVault(role: Party, instructions: readonly TransactionInstruction[]): Promise<void> {
  const sponsor = stack.sponsor.publicKey;
  const plan = wrapInVault({
    multisig: role.multisig,
    transactionIndex: role.next,
    member: role.member.publicKey,
    rentPayer: sponsor,
    instructions,
  });
  role.next += 1n;
  const options = { feePayer: sponsor, computeUnitPrice: PRICE };
  const propose = await client.buildTx(plan.propose, { ...options, computeUnitLimit: PROPOSE_UNITS });
  await send(role, propose.transaction);
  // Öneri işlemi zincirde: VaultTransaction hesabı mesajı taşır.
  stack.rpc.setAccount(plan.transaction, {
    owner: plan.execute.programId.toBase58(),
    data: vaultTransactionData({
      multisig: role.multisig,
      creator: role.member.publicKey,
      index: plan.transactionIndex,
      message: plan.message,
    }),
  });
  const execute = await client.buildTx([plan.execute], { ...options, computeUnitLimit: EXECUTE_UNITS });
  await send(role, execute.transaction);
}

async function send(role: Party | null, transaction: VersionedTransaction, signer?: Keypair) {
  transaction.sign([signer ?? role!.member]);
  const token = role ? role.token : await stack.session(signer!.publicKey);
  const response = await stack.request('POST', '/v1/sponsor', {
    body: { transaction: encode(transaction), submit: true },
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.body.error, JSON.stringify(response.body.error)).toBeNull();
  expect(response.status).toBe(200);
  accepted.push(response.body.data['instructions'] as string[]);
}

beforeAll(async () => {
  stack = await startStack();
  await truncate(stack.db);
  client = createSquareClient({ connection: stack.connection, programIds: PROGRAM_IDS, commitment: 'confirmed' });
  for (const role of [institution, agent, buyer]) role.token = await stack.session(role.member.publicKey);
  await world();
});

afterAll(async () => {
  await stack?.close();
});

/** SDK akışının zincirden okuduğu hesaplar: escrow config, politika, mint, job ve satılmış alacak. */
async function world(): Promise<void> {
  const escrow = client.escrow.program as unknown as Program<Idl>;
  const policy = client.policy.program as unknown as Program<Idl>;
  const sample = (program: Program<Idl>, name: string) => createSampler(program.idl).struct(name);
  const institutionPda = client.pda.institution(institution.vault)[0];
  const policyAddress = client.pda.policy(institutionPda, policyId)[0];
  const job = client.pda.job(institution.vault, specHash)[0];
  stack.rpc.setAccount(mint, { owner: TOKEN_PROGRAM_ID.toBase58(), data: Buffer.alloc(82) });
  await setProgramAccount(escrow, 'escrowConfig', client.pda.escrowConfig()[0], {
    ...sample(escrow, 'escrowConfig'),
    settlementMint: mint,
  });
  await setProgramAccount(policy, 'policy', policyAddress, {
    ...sample(policy, 'policy'),
    institution: institutionPda,
  });
  const jobData = sample(escrow, 'job');
  await setProgramAccount(escrow, 'job', job, {
    ...jobData,
    institution: institution.vault,
    agentRecord: client.pda.agentRecord(agent.vault, 'squads-agent')[0],
    agentWallet: agent.vault,
    mint,
    policy: policyAddress,
    rentPayer: stack.sponsor.publicKey,
    specHash: Array.from(specHash),
    dispute: { ...(jobData['dispute'] as Record<string, unknown>), bond: new BigNumber(0) as unknown as BN },
  });
  await setProgramAccount(escrow, 'claimListing', client.pda.claimListing(job)[0], {
    ...sample(escrow, 'claimListing'),
    job,
    seller: agent.vault,
    buyer: buyer.vault,
    status: { bought: {} },
    rentPayer: stack.sponsor.publicKey,
  });
}

describe('8 adım, Squads vault imzacılı ve sponsorlu', () => {
  it('her adımın öneri ve yürütme tx’i fee payer politikasından geçer ve sponsorlanır', async () => {
    const sponsor = stack.sponsor.publicKey;
    const feePayer = { feePayer: sponsor };
    const institutionPda = client.pda.institution(institution.vault)[0];
    const policyAddress = client.pda.policy(institutionPda, policyId)[0];
    const job = client.pda.job(institution.vault, specHash)[0];
    const ix = (built: Parameters<typeof builtTxInstructions>[0]) => builtTxInstructions(built);
    const builders = {
      policy: client.policy.instructions as unknown as Record<
        string,
        (a: unknown[], b: unknown) => Promise<TransactionInstruction>
      >,
      verifier: client.verifier.instructions as unknown as Record<
        string,
        (a: unknown[], b: unknown) => Promise<TransactionInstruction>
      >,
    };

    // 1. Kurum vault'u: kurum hesabı, politika commitment'ı ve onaylı alıcı listesi.
    await asVault(institution, [
      await builders.policy['initInstitution']!(['Squads kurum'], {
        payer: sponsor,
        authority: institution.vault,
        institution: institutionPda,
        systemProgram: SystemProgram.programId,
      }),
      await builders.policy['setPolicy']!([Array.from(policyId), new Array(32).fill(7), new BigNumber(1_000_000)], {
        payer: sponsor,
        authority: institution.vault,
        institution: institutionPda,
        policy: policyAddress,
        systemProgram: SystemProgram.programId,
      }),
      await builders.policy['setBuyerRoot']!([new Array(32).fill(9)], {
        authority: institution.vault,
        institution: institutionPda,
        policy: policyAddress,
      }),
    ]);

    // 2. Agent vault'u kaydın sahibi ve agent cüzdanı.
    const registered = await client.flow.registerAgent(
      {
        owner: agent.vault,
        agentId: 'squads-agent',
        agentCardUri: '',
        agentCardHash: new Uint8Array(32),
        wallet: agent.vault,
      },
      feePayer,
    );
    await asVault(agent, ix(registered));

    // 3. İş açma ve fonlama (kurumun USDC'si vault'unun ATA'sında).
    const created = await client.flow.createJob(
      {
        institution: institution.vault,
        agentRecord: registered.agentRecord,
        policy: policyAddress,
        spec,
        amount: 1_000_000n,
        deadline: 1_800_000_000,
        challengePeriod: 3_600n,
      },
      feePayer,
    );
    expect(created.job.equals(job)).toBe(true);
    await asVault(institution, ix(created));
    const institutionAta = getAssociatedTokenAddressSync(mint, institution.vault, true);
    await asVault(
      institution,
      ix(
        await client.flow.fundJob(
          { institution: institution.vault, job, institutionTokenAccount: institutionAta },
          feePayer,
        ),
      ),
    );

    // 4. Agent vault'u kabul eder ve teslim eder.
    await asVault(agent, ix(await client.flow.acceptJob({ agent: agent.vault, job }, feePayer)));
    await asVault(
      agent,
      ix(
        await client.flow.submitWork(
          { agent: agent.vault, job, workHash: new Uint8Array(32).fill(3), deliveryUri: 'https://d.square.test/w' },
          feePayer,
        ),
      ),
    );

    // 5. Alacak: agent vault'u listeler (listelemenin rent'i sponsordan), alıcı vault'u alır (satıcı ATA'sı sponsorlu).
    await asVault(agent, ix(await client.flow.listClaim({ agent: agent.vault, job, price: 900_000n }, feePayer)));
    await asVault(
      buyer,
      ix(
        await client.flow.buyClaim(
          {
            buyer: buyer.vault,
            job,
            price: 900_000n,
            leafSalt: new Uint8Array(32).fill(5),
            merkleProof: [new Uint8Array(32).fill(6)],
            buyerTokenAccount: getAssociatedTokenAddressSync(mint, buyer.vault, true),
          },
          feePayer,
        ),
      ),
    );

    // 6–7. Pencere kapanır; kurum vault'u ispatı bağlar (ReleaseProof'un rent'i sponsordan).
    await asVault(institution, [
      await builders.verifier['setComplianceProof']!(
        [
          new Array(64).fill(1),
          new Array(128).fill(2),
          new Array(64).fill(3),
          0,
          new BigNumber(990_000),
          new BigNumber(1_790_000_000),
        ],
        {
          payer: sponsor,
          authority: institution.vault,
          config: client.pda.verifierConfig()[0],
          institution: institutionPda,
          policy: policyAddress,
          job,
          claimListing: client.pda.claimListing(job)[0],
          operatorState: client.pda.operatorState(institutionPda)[0],
          releaseProof: client.pda.releaseProof(job)[0],
          systemProgram: SystemProgram.programId,
        },
      ),
    ]);

    // 8. Permissionless finalize: keeper kendi anahtarıyla imzalar, ücreti sponsor öder; job'un rent'i sponsora döner.
    const finalized = await client.flow.finalizePayment(
      { keeper: keeper.publicKey, job, keeperTokenAccount: getAssociatedTokenAddressSync(mint, keeper.publicKey) },
      { ...feePayer, computeUnitPrice: PRICE },
    );
    await send(null, finalized.transaction, keeper);

    // Her vault adımı iki tx (öneri + yürütme), finalize bir tx.
    const vaultSteps = 9;
    expect(accepted).toHaveLength(vaultSteps * 2 + 1);
    const inner = accepted.flat().filter((name) => name.startsWith('vault>'));
    expect(new Set(inner)).toEqual(
      new Set([
        'vault>policy:init_institution',
        'vault>policy:set_policy',
        'vault>policy:set_buyer_root',
        'vault>registry:register_agent',
        'vault>escrow:create_job',
        'vault>escrow:fund_job',
        'vault>escrow:accept_job',
        'vault>escrow:submit_work',
        'vault>escrow:list_claim',
        'vault>ata:create_idempotent',
        'vault>escrow:buy_claim',
        'vault>verifier:set_compliance_proof',
      ]),
    );
    expect(accepted.at(-1)).toContain('escrow:finalize_payment');
    const rows = await stack.db.sponsoredTx.findMany();
    expect(rows).toHaveLength(vaultSteps * 2 + 1);
    expect(rows.every((row) => row.status === 'submitted')).toBe(true);
    expect(stack.rpc.sent).toHaveLength(vaultSteps * 2 + 1);
  });
});
