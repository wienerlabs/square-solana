// Test fixture: anahtarlar çalışma anında üretilir; API görünümleri sözleşmedeki şemalarla (packages/types)
// doğrulanarak kurulur, böylece sahte API gerçek API'nin biçiminden sapamaz.
import { Program, type Idl } from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import {
  AgentViewSchema,
  DisputeViewSchema,
  JobViewSchema,
  type AgentView,
  type DisputeView,
  type InstructionCall,
  type JobStatus,
  type JobView,
} from '@squaresdk/solana-types';
import { encodeCall } from '../../src/transactions.js';

export const address = () => Keypair.generate().publicKey.toBase58();
export const hex32 = (byte: number) => Buffer.alloc(32, byte).toString('hex');
export const ZERO32 = hex32(0);
export const NOW = Math.floor(Date.now() / 1000);

export const ESCROW_PROGRAM = Keypair.generate().publicKey;
export const BLOCKHASH = new PublicKey(Buffer.alloc(32, 9)).toBase58();

export function jobView(
  overrides: { address?: string; status?: JobStatus; amount?: string } & Partial<JobView['account']> = {},
): JobView {
  const { address: jobAddress, ...account } = overrides;
  const agentWallet = account.agentWallet ?? address();
  return JobViewSchema.parse({
    address: jobAddress ?? address(),
    account: {
      institution: address(),
      agentRecord: address(),
      agentWallet,
      mint: address(),
      rentPayer: address(),
      amount: '1000000',
      specHash: hex32(1),
      status: 'funded',
      createdAt: NOW - 3600,
      fundedAt: NOW - 3000,
      deadline: NOW + 86_400,
      challengePeriod: '86400',
      challengeEnd: 0,
      deliveredAt: 0,
      settledAt: 0,
      workHash: ZERO32,
      travelRuleCommitment: ZERO32,
      policyCommitment: ZERO32,
      policyDailyCeiling: '0',
      policyVersion: 0,
      bump: 255,
      vaultBump: 254,
      bondBump: 253,
      policy: null,
      dispute: {
        challenger: PublicKey.default.toBase58(),
        bond: '0',
        reasonHash: ZERO32,
        raisedAt: 0,
        deadline: 0,
        decidedAt: 0,
        closedAt: 0,
        lapsed: false,
        approvalMask: 0,
        approvalCount: 0,
        arbitratorSetVersion: 0,
        resolution: { kind: 'pending' },
      },
      deliveryUri: '',
      ...account,
    },
    payee: agentWallet,
    claim: null,
    releaseProof: null,
    validation: null,
    slot: 100,
    indexedAt: NOW,
  });
}

export function disputeView(job: JobView): DisputeView {
  return DisputeViewSchema.parse({
    job: job.address,
    jobStatus: job.account.status,
    institution: job.account.institution,
    agentRecord: job.account.agentRecord,
    dispute: job.account.dispute,
    slot: 120,
    indexedAt: NOW,
  });
}

export function agentView(
  options: {
    address?: string;
    owner?: string;
    skills?: { id: string; tags: string[] }[];
    pricing?: { skillId: string; amount: string }[];
    jobsCompleted?: string;
    totalEarned?: string;
    cardVerified?: boolean;
    withCard?: boolean;
    withReputation?: boolean;
  } = {},
): AgentView {
  const agentRecord = options.address ?? address();
  const url = 'https://agent.example/a2a';
  const skills = options.skills ?? [{ id: 'translate', tags: ['language'] }];
  const mint = address();
  return AgentViewSchema.parse({
    address: agentRecord,
    account: {
      creator: options.owner ?? address(),
      owner: options.owner ?? address(),
      wallet: address(),
      agentCardHash: hex32(5),
      status: 'active',
      registeredAt: NOW - 86_400,
      updatedAt: NOW - 86_400,
      bump: 250,
      agentId: 'agent-1',
      agentCardUri: `https://api.example/a/${agentRecord}/.well-known/agent-card.json`,
    },
    did: `did:aip:solana:${agentRecord}`,
    card:
      options.withCard === false
        ? null
        : {
            type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
            name: `Agent ${agentRecord.slice(0, 4)}`,
            description: 'Test agent',
            url,
            version: '1.0.0',
            capabilities: { streaming: false, pushNotifications: false },
            defaultInputModes: ['text/plain'],
            defaultOutputModes: ['text/plain'],
            skills: skills.map((skill) => ({ ...skill, name: skill.id, description: `${skill.id} skill` })),
            services: [{ name: 'A2A', endpoint: url }],
            registrations: [
              {
                agentRegistry: `solana:${'1'.repeat(32)}:${address()}`,
                agentId: agentRecord,
              },
            ],
            pricing: (options.pricing ?? []).map((price) => ({ ...price, mint })),
          },
    cardVerified: options.cardVerified ?? true,
    reputation:
      options.withReputation === false
        ? null
        : {
            agentRecord,
            jobsCompleted: options.jobsCompleted ?? '3',
            jobsFailed: '1',
            jobsDisputed: '0',
            totalEarned: options.totalEarned ?? '3000000',
            firstJobAt: NOW - 10_000,
            lastJobAt: NOW - 100,
            bump: 249,
          },
    slot: 90,
    indexedAt: NOW,
  });
}

/** API'nin döndürdüğüne benzer imzasız v0 tx: compute budget + escrow talimatı, imzacılar sırayla. */
export function unsignedTx(options: {
  feePayer: PublicKey;
  signers?: PublicKey[];
  programId?: PublicKey;
  blockhash?: string;
}): VersionedTransaction {
  const signers = (options.signers ?? []).filter((signer) => !signer.equals(options.feePayer));
  const ix = new TransactionInstruction({
    programId: options.programId ?? ESCROW_PROGRAM,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from([7, 7, 7]),
  });
  const message = new TransactionMessage({
    payerKey: options.feePayer,
    recentBlockhash: options.blockhash ?? BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

export const toBase64 = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString('base64');

export const escrowProgram = (programId: PublicKey = ESCROW_PROGRAM): Program<Idl> =>
  new Program(
    { ...(SQUARE_IDLS.escrow as unknown as Idl), address: programId.toBase58() },
    {
      connection: new Connection('http://127.0.0.1:9'),
    },
  );

interface IdlAccountFlags {
  name: string;
  signer?: boolean;
  writable?: boolean;
}

export function preparedTx(options: {
  program: Program<Idl>;
  call: InstructionCall;
  accounts: Readonly<Record<string, string>>;
  feePayer: PublicKey;
  blockhash?: string;
  extra?: TransactionInstruction[];
}): VersionedTransaction {
  const { program, call } = options;
  const encoded = encodeCall(program, call);
  const idl = (program.idl.instructions as unknown as { name: string; accounts: IdlAccountFlags[] }[]).find(
    (candidate) => candidate.name === call.instruction,
  )!;
  const ix = new TransactionInstruction({
    programId: program.programId,
    keys: idl.accounts.map((account) => ({
      pubkey: options.accounts[account.name]
        ? new PublicKey(options.accounts[account.name]!)
        : Keypair.generate().publicKey,
      isSigner: account.signer ?? false,
      isWritable: account.writable ?? false,
    })),
    data: encoded.data,
  });
  const message = new TransactionMessage({
    payerKey: options.feePayer,
    recentBlockhash: options.blockhash ?? BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ix, ...(options.extra ?? [])],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}
