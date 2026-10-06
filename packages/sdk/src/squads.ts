// `@squaresdk/solana-sdk/squads`: Squads v4 smart account yardımcıları (BE-27). Kurum, agent ya da alıcı bir
// Squads v4 multisig'ine bağlandığında rol imzacısı multisig'in vault PDA'sıdır (BC-35, program arayüzü §2);
// ücreti ve rent'i rolü olmayan bir sponsor öder (fee payer servisi, ADR 0019).
//
// - Adresler `square_common::squads` ile aynı türetmedir (crates/square-common/src/squads.rs); test hem
//   crate'in sabit vektörünü hem resmi `@sqds/multisig` paketini karşılaştırır.
// - Talimatlar resmi `@sqds/multisig` paketinin kodlayıcılarıyladır. Akış BC-35 testlerinin modelidir: Square
//   talimatının yetkilisi vault, `payer`'ı sponsordur. Vault tx'i iki işlemdir: öneri (vault_transaction_create
//   + proposal_create + proposal_approve) ve yürütme (vault_transaction_execute). Sponsor yürütme işleminin de
//   imzacısı olduğundan iç talimattaki `payer` imzası karşılanır.
// - İç mesaj address lookup table kullanmaz: yürütmenin hesapları mesajdan yerelde çıkar ve fee payer servisi
//   iç talimatları ALT çözmeden denetler. Dış işlem (öneri ve yürütme) ALT kullanabilir.
import * as multisig from '@sqds/multisig';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  type AccountMeta,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { BuiltTx, Pda } from './types.js';

/** Squads v4 programı (her kümede aynı adres; `square_common::squads::PROGRAM_ID`). */
export const SQUADS_PROGRAM_ID = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');

/** `sha256("account:Multisig")[..8]` (`square_common::squads::MULTISIG_DISCRIMINATOR`). */
export const SQUADS_MULTISIG_DISCRIMINATOR: Readonly<Uint8Array> = Uint8Array.from([
  224, 116, 121, 186, 68, 161, 79, 236,
]);

/** `sha256("account:VaultTransaction")[..8]`. */
export const SQUADS_VAULT_TRANSACTION_DISCRIMINATOR: Readonly<Uint8Array> = Uint8Array.from(
  multisig.accounts.vaultTransactionDiscriminator,
);

/** Üye yetkileri (Squads v4 `Permission`): öneri açma, oy, yürütme. */
export const SquadsPermission = Object.freeze({ initiate: 1, vote: 2, execute: 4, all: 7 });

const SEED_PREFIX = Buffer.from('multisig');
const SEED_MULTISIG = Buffer.from('multisig');
const SEED_VAULT = Buffer.from('vault');
const SEED_TRANSACTION = Buffer.from('transaction');
const SEED_PROPOSAL = Buffer.from('proposal');
const SEED_PROGRAM_CONFIG = Buffer.from('program_config');

const u64Le = (value: bigint, label: string): Buffer => {
  if (value < 0n || value >= 2n ** 64n) throw new Error(`${label} u64 aralığı dışında: ${value}`);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

const find = (seeds: readonly Uint8Array[]): Pda => {
  const [address, bump] = PublicKey.findProgramAddressSync([...seeds], SQUADS_PROGRAM_ID);
  return [address, bump] as const;
};

/** Squads'ın program yapılandırması (`["multisig", "program_config"]`); hazine adresi buradadır. */
export const squadsProgramConfigAddress = (): Pda => find([SEED_PREFIX, SEED_PROGRAM_CONFIG]);

/** Multisig hesabı: `["multisig", "multisig", create_key]`. */
export const squadsMultisigAddress = (createKey: PublicKey): Pda =>
  find([SEED_PREFIX, SEED_MULTISIG, createKey.toBytes()]);

/** Multisig'in `vaultIndex`'inci vault PDA'sı: `["multisig", multisig, "vault", [vault_index]]` (crate'teki tanım). */
export function squadsVaultAddress(multisigAddress: PublicKey, vaultIndex = 0): Pda {
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    throw new Error(`vault indeksi 0–255 olmalı: ${vaultIndex}`);
  }
  return find([SEED_PREFIX, multisigAddress.toBytes(), SEED_VAULT, Uint8Array.of(vaultIndex)]);
}

/** Vault tx hesabı: `["multisig", multisig, "transaction", index u64]`. */
export const squadsTransactionAddress = (multisigAddress: PublicKey, index: bigint): Pda =>
  find([SEED_PREFIX, multisigAddress.toBytes(), SEED_TRANSACTION, u64Le(index, 'transactionIndex')]);

/** Öneri hesabı: `["multisig", multisig, "transaction", index u64, "proposal"]`. */
export const squadsProposalAddress = (multisigAddress: PublicKey, index: bigint): Pda =>
  find([SEED_PREFIX, multisigAddress.toBytes(), SEED_TRANSACTION, u64Le(index, 'transactionIndex'), SEED_PROPOSAL]);

// ---------------------------------------------------------------- talimat tablosu

/** Fee payer politikasının tanıdığı Squads v4 talimatları (snake_case, programın adları). */
export type SquadsInstructionName =
  | 'multisig_create_v2'
  | 'vault_transaction_create'
  | 'proposal_create'
  | 'proposal_approve'
  | 'vault_transaction_execute';

export interface SquadsInstructionLayout {
  readonly discriminator: Readonly<Uint8Array>;
  /** Sabit hesapların adları, talimattaki sırayla; ardından gelenler kalan hesaplardır. */
  readonly accounts: readonly string[];
}

const g = multisig.generated;

/** Talimatların discriminator'ları ve hesap sıraları (`@sqds/multisig` kodlayıcılarıyla aynı; test denetler). */
export const SQUADS_INSTRUCTIONS: Readonly<Record<SquadsInstructionName, SquadsInstructionLayout>> = Object.freeze({
  multisig_create_v2: {
    discriminator: Uint8Array.from(g.multisigCreateV2InstructionDiscriminator),
    accounts: ['program_config', 'treasury', 'multisig', 'create_key', 'creator', 'system_program'],
  },
  vault_transaction_create: {
    discriminator: Uint8Array.from(g.vaultTransactionCreateInstructionDiscriminator),
    accounts: ['multisig', 'transaction', 'creator', 'rent_payer', 'system_program'],
  },
  proposal_create: {
    discriminator: Uint8Array.from(g.proposalCreateInstructionDiscriminator),
    accounts: ['multisig', 'proposal', 'creator', 'rent_payer', 'system_program'],
  },
  proposal_approve: {
    discriminator: Uint8Array.from(g.proposalApproveInstructionDiscriminator),
    accounts: ['multisig', 'member', 'proposal'],
  },
  vault_transaction_execute: {
    discriminator: Uint8Array.from(g.vaultTransactionExecuteInstructionDiscriminator),
    accounts: ['multisig', 'proposal', 'transaction', 'member'],
  },
});

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Talimat verisinin adı; tabloda olmayan Squads talimatı null. */
export function squadsInstructionName(data: Uint8Array): SquadsInstructionName | null {
  const head = data.subarray(0, 8);
  for (const [name, layout] of Object.entries(SQUADS_INSTRUCTIONS)) {
    if (sameBytes(head, layout.discriminator)) return name as SquadsInstructionName;
  }
  return null;
}

// ---------------------------------------------------------------- vault tx mesajı

export interface VaultMessageInstruction {
  readonly programIdIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

/** Squads'ın vault tx mesajı (`VaultTransactionMessage`): v0 mesajının sıkıştırılmış biçimi. */
export interface VaultMessage {
  readonly numSigners: number;
  readonly numWritableSigners: number;
  readonly numWritableNonSigners: number;
  readonly accountKeys: readonly PublicKey[];
  readonly instructions: readonly VaultMessageInstruction[];
  readonly addressTableLookups: readonly {
    readonly accountKey: PublicKey;
    readonly writableIndexes: readonly number[];
    readonly readonlyIndexes: readonly number[];
  }[];
}

function toVaultMessage(
  raw: multisig.types.TransactionMessage | multisig.generated.VaultTransactionMessage,
): VaultMessage {
  return {
    numSigners: raw.numSigners,
    numWritableSigners: raw.numWritableSigners,
    numWritableNonSigners: raw.numWritableNonSigners,
    accountKeys: [...raw.accountKeys],
    instructions: raw.instructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accountIndexes: [...ix.accountIndexes],
      data: Uint8Array.from(ix.data),
    })),
    addressTableLookups: raw.addressTableLookups.map((lookup) => ({
      accountKey: lookup.accountKey,
      writableIndexes: [...lookup.writableIndexes],
      readonlyIndexes: [...lookup.readonlyIndexes],
    })),
  };
}

/** `vault_transaction_create`'in `transaction_message` baytları; bozuk ya da artık bayt bırakan veri reddedilir. */
export function decodeVaultMessage(bytes: Uint8Array): VaultMessage {
  const buffer = Buffer.from(bytes);
  let decoded: [multisig.types.TransactionMessage, number];
  try {
    decoded = multisig.types.transactionMessageBeet.deserialize(buffer);
  } catch (error) {
    throw new Error('vault tx mesajı çözülemedi', { cause: error });
  }
  if (decoded[1] !== buffer.length) throw new Error('vault tx mesajında artık bayt var');
  const message = toVaultMessage(decoded[0]);
  validateVaultMessage(message);
  return message;
}

/** Başlık sayıları ve indeksler mesajın hesaplarıyla tutarlı. */
function validateVaultMessage(message: VaultMessage): void {
  const keys = message.accountKeys.length;
  const loaded = message.addressTableLookups.reduce(
    (sum, lookup) => sum + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
    0,
  );
  if (
    message.numWritableSigners > message.numSigners ||
    message.numSigners > keys ||
    message.numWritableNonSigners > keys - message.numSigners
  ) {
    throw new Error('vault tx mesajının başlığı hesaplarla tutarsız');
  }
  for (const ix of message.instructions) {
    if (ix.programIdIndex >= keys || ix.accountIndexes.some((index) => index >= keys + loaded)) {
      throw new Error('vault tx mesajında hesap indeksi aralık dışında');
    }
  }
}

/** Mesajdaki statik hesabın yazılabilirliği (Squads `isStaticWritableIndex`). */
export function isVaultMessageWritable(message: VaultMessage, index: number): boolean {
  if (index >= message.accountKeys.length) return false;
  if (index < message.numSigners) return index < message.numWritableSigners;
  return index - message.numSigners < message.numWritableNonSigners;
}

/**
 * `vault_transaction_execute`'un kalan hesapları: mesajın statik hesapları sırayla. Vault PDA imzacı olarak
 * işaretlenmez (Squads `invoke_signed` ile imzalar); mesajdaki diğer imzacılar (sponsor) dış işlemin
 * imzacısıdır. Lookup table'lı mesaj desteklenmez.
 */
export function vaultExecuteAccounts(message: VaultMessage, vault: PublicKey): AccountMeta[] {
  if (message.addressTableLookups.length > 0) {
    throw new Error('lookup table kullanan vault tx mesajı desteklenmez');
  }
  return message.accountKeys.map((pubkey, index) => ({
    pubkey,
    isWritable: isVaultMessageWritable(message, index),
    isSigner: index < message.numSigners && !pubkey.equals(vault),
  }));
}

/** Zincirdeki `VaultTransaction` hesabı. */
export interface VaultTransactionAccount {
  readonly multisig: PublicKey;
  readonly creator: PublicKey;
  readonly index: bigint;
  readonly vaultIndex: number;
  readonly ephemeralSignerBumps: readonly number[];
  readonly message: VaultMessage;
}

/** `VaultTransaction` hesap verisi; discriminator'ı tutmayan ya da bozuk veri reddedilir. */
export function decodeVaultTransactionAccount(data: Uint8Array): VaultTransactionAccount {
  const buffer = Buffer.from(data);
  if (!sameBytes(buffer.subarray(0, 8), SQUADS_VAULT_TRANSACTION_DISCRIMINATOR)) {
    throw new Error('hesap bir Squads VaultTransaction değil');
  }
  let account: multisig.accounts.VaultTransaction;
  try {
    [account] = multisig.accounts.VaultTransaction.deserialize(buffer);
  } catch (error) {
    throw new Error('VaultTransaction hesabı çözülemedi', { cause: error });
  }
  const message = toVaultMessage(account.message);
  validateVaultMessage(message);
  return {
    multisig: account.multisig,
    creator: account.creator,
    index: BigInt(account.index.toString()),
    vaultIndex: account.vaultIndex,
    ephemeralSignerBumps: [...account.ephemeralSignerBumps],
    message,
  };
}

/** `vault_transaction_create` talimatının argümanları. */
export function decodeVaultTransactionCreate(data: Uint8Array): {
  vaultIndex: number;
  ephemeralSigners: number;
  message: VaultMessage;
} {
  let decoded: multisig.generated.VaultTransactionCreateInstructionArgs;
  try {
    [decoded] = g.vaultTransactionCreateStruct.deserialize(Buffer.from(data));
  } catch (error) {
    throw new Error('vault_transaction_create argümanları çözülemedi', { cause: error });
  }
  const { args } = decoded;
  return {
    vaultIndex: args.vaultIndex,
    ephemeralSigners: args.ephemeralSigners,
    message: decodeVaultMessage(args.transactionMessage),
  };
}

// ---------------------------------------------------------------- smart account

export interface SmartAccountMember {
  readonly key: PublicKey;
  /** `SquadsPermission` bitlerinin birleşimi. */
  readonly permissions: number;
}

/**
 * Smart account (Squads v4 multisig) açan `multisig_create_v2` talimatı. Rent'i ve programın oluşturma
 * ücretini `creator` öder (sponsorlu kurulumda sponsor); `createKey` tek kullanımlık bir anahtardır ve işlemi
 * imzalar. `configAuthority` verilmezse multisig özerktir (yapılandırma değişikliği üyelerin oyuyla).
 */
export function createSmartAccountInstruction(params: {
  createKey: PublicKey;
  creator: PublicKey;
  members: readonly SmartAccountMember[];
  threshold: number;
  /** Squads `ProgramConfig.treasury` (`readSquadsTreasury`). */
  treasury: PublicKey;
  timeLock?: number;
  configAuthority?: PublicKey | null;
  rentCollector?: PublicKey | null;
  memo?: string;
}): { instruction: TransactionInstruction; multisig: PublicKey; vault: PublicKey } {
  const { members, threshold } = params;
  const keys = new Set(members.map((member) => member.key.toBase58()));
  if (members.length === 0 || keys.size !== members.length) throw new Error('üyeler boş olamaz ve tekrar edemez');
  for (const member of members) {
    if (!Number.isInteger(member.permissions) || member.permissions < 1 || member.permissions > SquadsPermission.all) {
      throw new Error(`üye yetkisi 1–7 olmalı: ${member.key.toBase58()}`);
    }
  }
  const voters = members.filter((member) => (member.permissions & SquadsPermission.vote) !== 0).length;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > voters) {
    throw new Error(`eşik 1 ile oy verebilen üye sayısı (${voters}) arasında olmalı: ${threshold}`);
  }
  const address = squadsMultisigAddress(params.createKey)[0];
  const instruction = multisig.instructions.multisigCreateV2({
    treasury: params.treasury,
    creator: params.creator,
    multisigPda: address,
    configAuthority: params.configAuthority ?? null,
    threshold,
    members: members.map((member) => ({ key: member.key, permissions: { mask: member.permissions } })),
    timeLock: params.timeLock ?? 0,
    createKey: params.createKey,
    rentCollector: params.rentCollector ?? null,
    ...(params.memo === undefined ? {} : { memo: params.memo }),
    programId: SQUADS_PROGRAM_ID,
  });
  return { instruction, multisig: address, vault: squadsVaultAddress(address, 0)[0] };
}

/** Squads `ProgramConfig`'teki hazine (oluşturma ücretinin alıcısı); `multisig_create_v2` ister. */
export async function readSquadsTreasury(connection: Connection): Promise<PublicKey> {
  const address = squadsProgramConfigAddress()[0];
  const info = await connection.getAccountInfo(address);
  if (!info || !info.owner.equals(SQUADS_PROGRAM_ID)) {
    throw new Error(`Squads program yapılandırması bulunamadı: ${address.toBase58()}`);
  }
  return multisig.accounts.ProgramConfig.fromAccountInfo(info)[0].treasury;
}

export interface SmartAccountState {
  readonly threshold: number;
  readonly timeLock: number;
  /** Son açılan vault tx'inin indeksi; sıradaki `transactionIndex + 1`'dir. */
  readonly transactionIndex: bigint;
  readonly members: readonly SmartAccountMember[];
}

/** Squads v4 `Multisig` hesap verisi; discriminator'ı tutmayan veri reddedilir. */
export function decodeSmartAccount(data: Uint8Array): SmartAccountState {
  const buffer = Buffer.from(data);
  if (!sameBytes(buffer.subarray(0, 8), SQUADS_MULTISIG_DISCRIMINATOR)) {
    throw new Error('hesap bir Squads Multisig değil');
  }
  const [account] = multisig.accounts.Multisig.deserialize(buffer);
  return {
    threshold: account.threshold,
    timeLock: account.timeLock,
    transactionIndex: BigInt(account.transactionIndex.toString()),
    members: account.members.map((member) => ({ key: member.key, permissions: member.permissions.mask })),
  };
}

/** Zincirdeki smart account. */
export async function readSmartAccount(connection: Connection, address: PublicKey): Promise<SmartAccountState> {
  const info = await connection.getAccountInfo(address);
  if (!info || !info.owner.equals(SQUADS_PROGRAM_ID))
    throw new Error(`smart account bulunamadı: ${address.toBase58()}`);
  return decodeSmartAccount(info.data);
}

// ---------------------------------------------------------------- vault ile sarma

export interface VaultTransactionPlan {
  readonly transactionIndex: bigint;
  readonly vault: PublicKey;
  readonly transaction: PublicKey;
  readonly proposal: PublicKey;
  /** Öneri işlemi: `vault_transaction_create`, `proposal_create` ve (eşik 1 ise) `proposal_approve`. */
  readonly propose: readonly TransactionInstruction[];
  /** Yürütme işlemi: `vault_transaction_execute`; önerinin onaylanmış olması gerekir. */
  readonly execute: TransactionInstruction;
  /** Vault tx mesajı (zincirde `VaultTransaction.message` olarak durur). */
  readonly message: VaultMessage;
}

/**
 * Square talimatlarını vault tx'ine sarar. Talimatlarda yetkili vault PDA'sı, `payer` sponsor olmalıdır
 * (`flow` builder'larına `feePayer: sponsor` ve rol adresi olarak vault verilir). `member` öneriyi açan,
 * onaylayan ve yürüten üyedir; `rentPayer` VaultTransaction ve Proposal hesaplarının rent'ini öder.
 */
export function wrapInVault(params: {
  multisig: PublicKey;
  /** Sıradaki indeks: `readSmartAccount(...).transactionIndex + 1n`. */
  transactionIndex: bigint;
  member: PublicKey;
  rentPayer: PublicKey;
  instructions: readonly TransactionInstruction[];
  vaultIndex?: number;
  /** Öneri aynı işlemde üyece onaylanır (varsayılan; eşiği 1 olan smart account). */
  approve?: boolean;
  memo?: string;
}): VaultTransactionPlan {
  const { transactionIndex, member } = params;
  if (transactionIndex < 1n) throw new Error(`transactionIndex en az 1 olmalı: ${transactionIndex}`);
  if (params.instructions.length === 0) throw new Error('vault tx için en az bir talimat gerekli');
  const vaultIndex = params.vaultIndex ?? 0;
  const vault = squadsVaultAddress(params.multisig, vaultIndex)[0];
  const transactionMessage = new TransactionMessage({
    payerKey: vault,
    // Squads mesajın blockhash'ini kullanmaz; işlemin kendi blockhash'i geçerlidir.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [...params.instructions],
  });
  const bytes = multisig.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: transactionMessage,
    vaultPda: vault,
  });
  const message = decodeVaultMessage(bytes);
  const create = multisig.instructions.vaultTransactionCreate({
    multisigPda: params.multisig,
    transactionIndex,
    creator: member,
    rentPayer: params.rentPayer,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage,
    ...(params.memo === undefined ? {} : { memo: params.memo }),
    programId: SQUADS_PROGRAM_ID,
  });
  const proposal = multisig.instructions.proposalCreate({
    multisigPda: params.multisig,
    creator: member,
    rentPayer: params.rentPayer,
    transactionIndex,
    programId: SQUADS_PROGRAM_ID,
  });
  const propose = [create, proposal];
  if (params.approve ?? true) {
    propose.push(
      multisig.instructions.proposalApprove({
        multisigPda: params.multisig,
        transactionIndex,
        member,
        programId: SQUADS_PROGRAM_ID,
      }),
    );
  }
  const transaction = squadsTransactionAddress(params.multisig, transactionIndex)[0];
  const proposalAddress = squadsProposalAddress(params.multisig, transactionIndex)[0];
  const execute = g.createVaultTransactionExecuteInstruction(
    {
      multisig: params.multisig,
      proposal: proposalAddress,
      transaction,
      member,
      anchorRemainingAccounts: vaultExecuteAccounts(message, vault),
    },
    SQUADS_PROGRAM_ID,
  );
  return { transactionIndex, vault, transaction, proposal: proposalAddress, propose, execute, message };
}

/**
 * SDK akışının ürettiği tx'in (ör. `flow.registerAgent`) talimatları, compute budget talimatları hariç;
 * `wrapInVault`'a verilir. Tx ALT kullanıyorsa tabloları verilmelidir.
 */
export function builtTxInstructions(
  built: BuiltTx,
  addressLookupTableAccounts: readonly AddressLookupTableAccount[] = [],
): TransactionInstruction[] {
  const message = TransactionMessage.decompile(built.transaction.message, {
    addressLookupTableAccounts: [...addressLookupTableAccounts],
  });
  return message.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
}
