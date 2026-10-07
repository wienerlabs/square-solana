// Sponsorlu gönderim (FE-21). İki yol:
// - Cüzdan: tx'in ücret ödeyicisi ve rent ödeyicisi sponsordur (`feePayer: sponsor` ile kurulur), rol imzacısı
//   cüzdandır. Cüzdan imzalar, servis denetleyip sponsorla imzalar ve gönderir.
// - Smart account: tx'in talimatları vault adına çalışır (rol adresi vault, `payer` sponsor). Talimatlar vault tx'ine
//   sarılır (SDK `wrapInVault`); öneri ve yürütme ayrı iki sponsorlu işlemdir. Öneri zincirde onaylanınca yürütme
//   kurulur: yürütmenin hesapları ve compute unit ölçümü önerinin zincirdeki hâline bağlıdır.
// Gönderim, ağ korumasından (FE-03) geçmeyen işlemi cüzdana götürmez.
import {
  SquadsPermission,
  createSmartAccountInstruction,
  readSquadsTreasury,
  wrapInVault,
} from '@squaresdk/solana-sdk/squads';
import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { FeePayerError, sponsorErrorText, type SponsorInfo, type SponsorResult } from './fee-payer';
import { TransactionBlockedError, type TransactionGate } from './send-transaction';
import {
  actsAlone,
  feePayerOf,
  prepareSponsoredTx,
  proposeProblem,
  readSmartAccount,
  transactionInstructions,
  type PreparedTx,
  type SmartAccountMember,
} from './smart-account';

export interface SponsorChannel {
  readonly info: SponsorInfo;
  /** İmzalı tx'i servise verir (`submit: true`); servisin sonucu. */
  submit(transaction: VersionedTransaction): Promise<SponsorResult>;
}

export interface MemberSigner {
  readonly publicKey: PublicKey;
  signTransaction(transaction: VersionedTransaction): Promise<VersionedTransaction>;
}

/** Öneri açıldı, yürütme diğer üyelerin onayını (ya da zaman kilidini) bekliyor. */
export class ProposalPendingError extends Error {
  constructor(
    readonly index: bigint,
    readonly approvals: number,
    readonly threshold: number,
    readonly proposeSignature: string,
  ) {
    super(
      `Proposed as smart account transaction #${index} (${approvals} of ${threshold} approvals). It runs once the ` +
        'other members approve it and a member executes it from the account page.',
    );
    this.name = 'ProposalPendingError';
  }
}

function guard(gate: TransactionGate): void {
  if (!gate.canTransact) {
    throw new TransactionBlockedError(
      gate.problems.length > 0 ? gate.problems.join(' ') : 'The network has not been verified yet.',
    );
  }
}

const sponsorKey = (channel: SponsorChannel) => new PublicKey(channel.info.sponsor);

/** Cüzdan imzalı, sponsorun ödediği tx; tx'in ücret ödeyicisi sponsor olmalı. */
export async function sendSponsored(
  gate: TransactionGate,
  channel: SponsorChannel,
  signer: MemberSigner,
  transaction: VersionedTransaction,
): Promise<string> {
  guard(gate);
  if (!feePayerOf(transaction).equals(sponsorKey(channel))) {
    throw new Error("The transaction's fee payer is not the sponsor.");
  }
  const signed = await signer.signTransaction(transaction);
  return (await channel.submit(signed)).signature;
}

/** Sponsorlu işlemin zincirde onaylanmasını bekler; düşen tx hata. */
async function confirmed(connection: Connection, prepared: PreparedTx, signature: string): Promise<string> {
  const { value } = await connection.confirmTransaction(
    { signature, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight },
    'confirmed',
  );
  if (value.err) throw new Error(`The sponsored transaction ${signature} failed: ${JSON.stringify(value.err)}`);
  return signature;
}

/** Sponsorlu işlemi imzalatır, gönderir ve zincirde onaylanmasını bekler. */
async function submitConfirmed(
  connection: Connection,
  channel: SponsorChannel,
  signer: MemberSigner,
  prepared: PreparedTx,
): Promise<string> {
  const signed = await signer.signTransaction(prepared.transaction);
  return confirmed(connection, prepared, (await channel.submit(signed)).signature);
}

/**
 * Smart account'u sponsorla açar (`multisig_create_v2`): sponsor `creator`'dır, rent'i ve Squads'ın oluşturma
 * ücretini öder. `createKey` burada üretilen tek kullanımlık anahtardır ve yalnızca bu tx'i imzalar; cüzdan imza
 * atmaz. Multisig özerktir (yapılandırma değişikliği üyelerin oyuyla), zaman kilidi yoktur.
 */
export async function createSmartAccount(
  params: { connection: Connection; gate: TransactionGate; channel: SponsorChannel },
  draft: { members: readonly SmartAccountMember[]; threshold: number },
): Promise<{ multisig: PublicKey; vault: PublicKey; signature: string }> {
  const { connection, channel } = params;
  guard(params.gate);
  const createKey = Keypair.generate();
  const sponsor = sponsorKey(channel);
  const { instruction, multisig, vault } = createSmartAccountInstruction({
    createKey: createKey.publicKey,
    creator: sponsor,
    treasury: await readSquadsTreasury(connection),
    members: draft.members.map((member) => ({ key: new PublicKey(member.key), permissions: member.permissions })),
    threshold: draft.threshold,
  });
  const prepared = await prepareSponsoredTx(connection, {
    sponsor,
    instructions: [instruction],
    maxComputeUnits: channel.info.maxComputeUnitLimit,
  });
  prepared.transaction.sign([createKey]);
  const signature = await confirmed(connection, prepared, (await channel.submit(prepared.transaction)).signature);
  return { multisig, vault, signature };
}

export interface VaultSendParams {
  readonly connection: Connection;
  readonly gate: TransactionGate;
  readonly channel: SponsorChannel;
  readonly signer: MemberSigner;
  readonly multisig: PublicKey;
  /** Dış işlemlerin (öneri, yürütme) ALT'ları: Square ALT'ı. İç mesaj ALT kullanmaz. */
  readonly lookupTables?: readonly AddressLookupTableAccount[];
}

/**
 * Talimatları smart account'un vault'u adına çalıştırır: öneri (vault tx + proposal + üyenin onayı), sonra
 * yürütme. Cüzdan tek başına yürütemiyorsa (eşik, zaman kilidi ya da yetki) öneriden sonra `ProposalPendingError`.
 * Dönen imza yürütmeninkidir.
 */
export async function sendInstructionsAsVault(
  params: VaultSendParams,
  instructions: readonly TransactionInstruction[],
): Promise<string> {
  const { connection, gate, channel, signer, multisig } = params;
  guard(gate);
  if (instructions.length === 0) throw new Error('There is nothing to run as the smart account.');
  const sponsor = sponsorKey(channel);
  const view = await readSmartAccount(connection, multisig);
  const wallet = signer.publicKey.toBase58();
  const problem = proposeProblem(view, wallet);
  if (problem) throw new TransactionBlockedError(problem);
  const member = view.members.find((entry) => entry.key === wallet)!;
  const votes = (member.permissions & SquadsPermission.vote) !== 0;
  const plan = wrapInVault({
    multisig,
    transactionIndex: view.transactionIndex + 1n,
    member: signer.publicKey,
    rentPayer: sponsor,
    instructions,
    approve: votes,
  });
  const maxComputeUnits = channel.info.maxComputeUnitLimit;
  const lookupTables = params.lookupTables ?? [];
  const propose = await prepareSponsoredTx(connection, {
    sponsor,
    instructions: plan.propose,
    lookupTables,
    maxComputeUnits,
  });
  const proposeSignature = await submitConfirmed(connection, channel, signer, propose);
  if (!actsAlone(view, wallet)) {
    throw new ProposalPendingError(plan.transactionIndex, votes ? 1 : 0, view.threshold, proposeSignature);
  }
  const execute = await prepareSponsoredTx(connection, {
    sponsor,
    instructions: [plan.execute],
    lookupTables,
    maxComputeUnits,
  });
  const signed = await signer.signTransaction(execute.transaction);
  return (await channel.submit(signed)).signature;
}

/** SDK'nın kurduğu tx'i (rol vault, `payer` sponsor) vault adına çalıştırır. */
export async function sendAsVault(params: VaultSendParams, transaction: VersionedTransaction): Promise<string> {
  if (!feePayerOf(transaction).equals(sponsorKey(params.channel))) {
    throw new Error("The transaction's fee payer is not the sponsor.");
  }
  return sendInstructionsAsVault(params, await transactionInstructions(params.connection, transaction));
}

/** Zincirdeki bir öneriyi üyenin onayıyla onaylar (`proposal_approve`), sponsorlu. */
export async function approveProposal(
  params: Omit<VaultSendParams, 'multisig'>,
  instruction: TransactionInstruction,
): Promise<string> {
  guard(params.gate);
  const prepared = await prepareSponsoredTx(params.connection, {
    sponsor: sponsorKey(params.channel),
    instructions: [instruction],
    lookupTables: params.lookupTables ?? [],
    maxComputeUnits: params.channel.info.maxComputeUnitLimit,
  });
  return submitConfirmed(params.connection, params.channel, params.signer, prepared);
}

/** Onaylanmış bir öneriyi yürütür (`vault_transaction_execute`), sponsorlu. */
export async function executeProposal(
  params: Omit<VaultSendParams, 'multisig'>,
  execute: { instruction: TransactionInstruction; lookupTables: AddressLookupTableAccount[] },
): Promise<string> {
  guard(params.gate);
  const prepared = await prepareSponsoredTx(params.connection, {
    sponsor: sponsorKey(params.channel),
    instructions: [execute.instruction],
    lookupTables: [...(params.lookupTables ?? []), ...execute.lookupTables],
    maxComputeUnits: params.channel.info.maxComputeUnitLimit,
  });
  return submitConfirmed(params.connection, params.channel, params.signer, prepared);
}

/**
 * Rol adına gönderimin (FE-21) arayüz metni: ağ koruması ve bekleyen öneri kendi mesajıyla, sponsorun reddi
 * sebebiyle (`sponsorErrorText`), program hatası bileşenin IDL açıklamasıyla (`programMessage`).
 */
export function sendErrorText(error: unknown, programMessage: (error: unknown) => string | null): string {
  if (error instanceof TransactionBlockedError || error instanceof ProposalPendingError) return error.message;
  if (error instanceof FeePayerError) return sponsorErrorText(error);
  return programMessage(error) ?? (error as Error).message;
}
