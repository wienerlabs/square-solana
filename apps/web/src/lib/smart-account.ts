// Smart account (Squads v4 multisig) ile çalışan roller (FE-21). Rolün zincirdeki adresi multisig'in 0 numaralı vault
// PDA'sıdır (BC-35, program arayüzü §2): kurum, agent ya da alıcının işlemleri vault adına önerilir ve yürütülür.
// İşlem ücretini ve açılan hesapların rent'ini sponsor öder (BE-27): vault SOL tutmaz.
// - Smart account sponsorla açılır (`createSmartAccountInstruction`, `creator` sponsor). `createKey` bu tarayıcıda
//   üretilen tek kullanımlık bir anahtardır, yalnızca açılış tx'ini imzalar.
// - Seçim cüzdan ve rol başına bu tarayıcıda tutulur (`localStorage.square-smart-account:<cüzdan>:<rol>`); adres
//   zincirden okunur ve cüzdanın üyeliği her okumada denetlenir.
// - Bir adım iki işlemdir (SDK `wrapInVault`): öneri (vault tx + proposal + üyenin onayı) ve yürütme. İç mesaj ALT
//   kullanmaz (sponsor servisi iç talimatları ALT çözmeden denetler); dış işlemler Square ALT'ını kullanabilir.
//   Eşik 1'den büyükse ya da zaman kilidi varsa öneri diğer üyelerin onayını bekler: onay ve yürütme hesap
//   sayfasındaki öneri listesinden yapılır.
import * as squads from '@sqds/multisig';
import {
  SQUADS_PROGRAM_ID,
  SquadsPermission,
  decodeVaultTransactionAccount,
  squadsProposalAddress,
  squadsTransactionAddress,
  squadsVaultAddress,
} from '@squaresdk/solana-sdk/squads';
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { isAddress } from './config';
import type { Role } from './roles';

/** Smart account'la çalışabilen roller; arbitrator cüzdanıyla oy verir (API'nin arbitrator uçları da öyle). */
export const SMART_ACCOUNT_ROLES = ['institution', 'agent', 'buyer'] as const satisfies readonly Role[];
export type SmartAccountRole = (typeof SMART_ACCOUNT_ROLES)[number];

export const isSmartAccountRole = (role: Role | null): role is SmartAccountRole =>
  role !== null && (SMART_ACCOUNT_ROLES as readonly string[]).includes(role);

// ---------------------------------------------------------------- seçim

const storageKey = (wallet: string, role: SmartAccountRole) => `square-smart-account:${wallet}:${role}`;

/** Rolün seçili smart account'u (multisig adresi); yoksa ya da depolama okunamıyorsa null. */
export function readSmartAccountChoice(wallet: string, role: SmartAccountRole): string | null {
  try {
    const value = window.localStorage.getItem(storageKey(wallet, role));
    return value && isAddress(value) ? value : null;
  } catch {
    return null;
  }
}

/** Seçimi yazar; null cüzdanla çalışmaya döner. Yazılamazsa seçim bu oturumla sınırlı kalır. */
export function writeSmartAccountChoice(wallet: string, role: SmartAccountRole, multisig: string | null): void {
  try {
    if (multisig === null) window.localStorage.removeItem(storageKey(wallet, role));
    else window.localStorage.setItem(storageKey(wallet, role), multisig);
  } catch {
    // Kaydedilemezse seçim bu oturumla sınırlı kalır.
  }
}

// ---------------------------------------------------------------- hesap

export interface SmartAccountMember {
  readonly key: string;
  /** `SquadsPermission` bitleri. */
  readonly permissions: number;
}

export interface SmartAccountView {
  readonly address: string;
  /** 0 numaralı vault: rolün zincirdeki adresi. */
  readonly vault: string;
  readonly threshold: number;
  /** Onaydan sonra yürütmeye kadar beklenen saniye. */
  readonly timeLock: number;
  /** Son açılan vault tx'inin indeksi; sıradaki `transactionIndex + 1`. */
  readonly transactionIndex: bigint;
  /** Bu indekse kadar olan öneriler bayattır (üyelik ya da eşik değişti), yürütülemez. */
  readonly staleTransactionIndex: bigint;
  readonly members: readonly SmartAccountMember[];
}

const big = (value: { toString(): string } | number) => BigInt(value.toString());

/** Squads v4 `Multisig` hesap verisi; başka program ya da tür reddedilir. */
export function decodeSmartAccount(address: PublicKey, owner: PublicKey, data: Buffer): SmartAccountView {
  if (!owner.equals(SQUADS_PROGRAM_ID)) throw new Error('The account is not owned by the Squads v4 program.');
  let account: squads.accounts.Multisig;
  try {
    [account] = squads.accounts.Multisig.deserialize(data);
  } catch {
    throw new Error('The account is not a Squads v4 smart account.');
  }
  return {
    address: address.toBase58(),
    vault: squadsVaultAddress(address, 0)[0].toBase58(),
    threshold: account.threshold,
    timeLock: account.timeLock,
    transactionIndex: big(account.transactionIndex),
    staleTransactionIndex: big(account.staleTransactionIndex),
    members: account.members.map((member) => ({ key: member.key.toBase58(), permissions: member.permissions.mask })),
  };
}

export async function readSmartAccount(connection: Connection, address: PublicKey): Promise<SmartAccountView> {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) throw new Error(`No smart account at ${address.toBase58()} on this network.`);
  return decodeSmartAccount(address, info.owner, info.data);
}

export const PERMISSION_NAMES: readonly (readonly [string, number])[] = [
  ['Initiate', SquadsPermission.initiate],
  ['Vote', SquadsPermission.vote],
  ['Execute', SquadsPermission.execute],
];

export const permissionNames = (mask: number): string[] =>
  PERMISSION_NAMES.filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);

export const memberOf = (view: SmartAccountView, wallet: string): SmartAccountMember | null =>
  view.members.find((member) => member.key === wallet) ?? null;

/** Oy verebilen üye sayısı; eşik bundan büyük olamaz. */
export const voters = (view: SmartAccountView): number =>
  view.members.filter((member) => (member.permissions & SquadsPermission.vote) !== 0).length;

/**
 * Cüzdan rol adına öneri açabilir mi; açamıyorsa sebebi. Öneri `Initiate` ister. Tek başına yürütme (eşik 1,
 * zaman kilidi yok, cüzdan oy verir ve yürütür) `actsAlone`'dadır.
 */
export function proposeProblem(view: SmartAccountView, wallet: string): string | null {
  const member = memberOf(view, wallet);
  if (!member) return 'This wallet is not a member of the smart account.';
  if ((member.permissions & SquadsPermission.initiate) === 0) {
    return 'This wallet cannot propose transactions in the smart account (it lacks Initiate).';
  }
  return null;
}

/** Cüzdanın onayıyla öneri hemen yürütülebilir mi: eşik 1, zaman kilidi 0, cüzdan oy verir ve yürütür. */
export function actsAlone(view: SmartAccountView, wallet: string): boolean {
  const member = memberOf(view, wallet);
  return (
    member !== null &&
    (member.permissions & SquadsPermission.all) === SquadsPermission.all &&
    view.threshold === 1 &&
    view.timeLock === 0
  );
}

// ---------------------------------------------------------------- açılış

/** Smart account taslağı: bağlı cüzdan her zaman üyedir; diğer üyeler bütün yetkilerle eklenir. */
export interface SmartAccountDraft {
  /** Bağlı cüzdanın dışındaki üyeler (satır ya da virgülle ayrılmış adresler). */
  readonly others: string;
  readonly threshold: string;
}

export type DraftCheck = { ok: true; members: SmartAccountMember[]; threshold: number } | { ok: false; error: string };

/** Taslağın üyeleri ve eşiği; SDK'nın kurallarıyla aynı (üye tekrarı yok, 1 ≤ eşik ≤ oy veren üye). */
export function checkSmartAccountDraft(wallet: string, draft: SmartAccountDraft): DraftCheck {
  const others = draft.others
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const invalid = others.find((value) => !isAddress(value));
  if (invalid) return { ok: false, error: `${invalid} is not a Solana address.` };
  const keys = [wallet, ...others];
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'A member is listed twice.' };
  if (!/^[1-9][0-9]*$/.test(draft.threshold.trim())) return { ok: false, error: 'The threshold is a whole number.' };
  const threshold = Number(draft.threshold.trim());
  if (threshold > keys.length) {
    return { ok: false, error: `The threshold is at most the number of members (${keys.length}).` };
  }
  return {
    ok: true,
    members: keys.map((key) => ({ key, permissions: SquadsPermission.all })),
    threshold,
  };
}

// ---------------------------------------------------------------- öneriler

export type ProposalStatus = 'draft' | 'active' | 'rejected' | 'approved' | 'executing' | 'executed' | 'cancelled';

export interface ProposalView {
  readonly index: bigint;
  readonly status: ProposalStatus;
  /** Durumun zamanı (Unix saniyesi); `executing` için yok. */
  readonly statusAt: number | null;
  readonly approved: readonly string[];
  readonly rejected: readonly string[];
  readonly cancelled: readonly string[];
  /** Vault tx'inin iç talimatlarının programları; hesap kapatılmışsa null. */
  readonly programs: readonly string[] | null;
  /** İndeks `staleTransactionIndex`'e kadarsa öneri yürütülemez. */
  readonly stale: boolean;
}

/** Okunan en fazla öneri: sondan geriye. */
export const PROPOSAL_LIMIT = 10;

/** Son öneriler (yeniden eskiye); kapatılmış (rent'i geri alınmış) öneriler listede yoktur. */
export async function readProposals(
  connection: Connection,
  view: SmartAccountView,
  limit = PROPOSAL_LIMIT,
): Promise<ProposalView[]> {
  const multisig = new PublicKey(view.address);
  const indices: bigint[] = [];
  for (let index = view.transactionIndex; index >= 1n && indices.length < limit; index -= 1n) indices.push(index);
  if (indices.length === 0) return [];
  const proposals = indices.map((index) => squadsProposalAddress(multisig, index)[0]);
  const transactions = indices.map((index) => squadsTransactionAddress(multisig, index)[0]);
  const infos = await connection.getMultipleAccountsInfo([...proposals, ...transactions], 'confirmed');
  const views: ProposalView[] = [];
  indices.forEach((index, position) => {
    const proposal = infos[position];
    if (!proposal || !proposal.owner.equals(SQUADS_PROGRAM_ID)) return;
    const [account] = squads.accounts.Proposal.fromAccountInfo(proposal);
    const transaction = infos[indices.length + position];
    let programs: string[] | null = null;
    if (transaction && transaction.owner.equals(SQUADS_PROGRAM_ID)) {
      try {
        const { message } = decodeVaultTransactionAccount(transaction.data);
        programs = [...new Set(message.instructions.map((ix) => message.accountKeys[ix.programIdIndex]!.toBase58()))];
      } catch {
        programs = null;
      }
    }
    const status = account.status;
    views.push({
      index,
      status: status.__kind.toLowerCase() as ProposalStatus,
      statusAt: 'timestamp' in status ? Number(big(status.timestamp)) : null,
      approved: account.approved.map((key) => key.toBase58()),
      rejected: account.rejected.map((key) => key.toBase58()),
      cancelled: account.cancelled.map((key) => key.toBase58()),
      programs,
      stale: index <= view.staleTransactionIndex,
    });
  });
  return views;
}

/** Cüzdanın öneride atabileceği adım; atamıyorsa null. */
export function proposalAction(
  view: SmartAccountView,
  proposal: ProposalView,
  wallet: string,
  nowSeconds: number,
): 'approve' | 'execute' | null {
  const member = memberOf(view, wallet);
  if (!member || proposal.stale) return null;
  if (proposal.status === 'active') {
    const voted = [...proposal.approved, ...proposal.rejected].includes(wallet);
    return !voted && (member.permissions & SquadsPermission.vote) !== 0 ? 'approve' : null;
  }
  if (proposal.status === 'approved' && (member.permissions & SquadsPermission.execute) !== 0) {
    const unlocked = proposal.statusAt === null || nowSeconds >= proposal.statusAt + view.timeLock;
    return unlocked ? 'execute' : null;
  }
  return null;
}

/** Üyenin onay talimatı (`proposal_approve`). */
export const approveInstruction = (view: SmartAccountView, index: bigint, member: PublicKey): TransactionInstruction =>
  squads.instructions.proposalApprove({
    multisigPda: new PublicKey(view.address),
    transactionIndex: index,
    member,
    programId: SQUADS_PROGRAM_ID,
  });

/** Zincirdeki vault tx'ini yürüten talimat (`vault_transaction_execute`); hesaplar tx'in mesajından. */
export async function executeInstruction(
  connection: Connection,
  view: SmartAccountView,
  index: bigint,
  member: PublicKey,
): Promise<{ instruction: TransactionInstruction; lookupTables: AddressLookupTableAccount[] }> {
  const { instruction, lookupTableAccounts } = await squads.instructions.vaultTransactionExecute({
    connection,
    multisigPda: new PublicKey(view.address),
    transactionIndex: index,
    member,
    programId: SQUADS_PROGRAM_ID,
  });
  return { instruction, lookupTables: lookupTableAccounts };
}

// ---------------------------------------------------------------- tx'ler

/** Paket sınırı (bayt). */
const PACKET_DATA_SIZE = 1232;
/** Ölçülen compute unit'e eklenen pay: ölçüm ile gönderim arasında hesaplar değişebilir. */
const COMPUTE_MARGIN = 1.2;
const COMPUTE_FLOOR = 5_000;
/** Ölçüm tx'inin sınırı (protokolün tavanı). */
const MAX_COMPUTE_UNITS = 1_400_000;

/** Bir tx'in talimatları (compute budget hariç); tx ALT kullanıyorsa tablolar zincirden okunur. */
export async function transactionInstructions(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<TransactionInstruction[]> {
  const lookups = transaction.message.addressTableLookups;
  const tables = await Promise.all(
    lookups.map(async (lookup) => {
      const { value } = await connection.getAddressLookupTable(lookup.accountKey, { commitment: 'confirmed' });
      if (!value) throw new Error(`The address lookup table ${lookup.accountKey.toBase58()} is not on chain.`);
      return value;
    }),
  );
  return TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables }).instructions.filter(
    (instruction) => !instruction.programId.equals(ComputeBudgetProgram.programId),
  );
}

/** Tx tel biçiminde paket sınırına sığıyor mu (web3.js sığmayan mesajda RangeError verir). */
function fits(transaction: VersionedTransaction): boolean {
  try {
    return transaction.serialize().length <= PACKET_DATA_SIZE;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

function compile(
  payer: PublicKey,
  blockhash: string,
  instructions: readonly TransactionInstruction[],
  lookupTables: readonly AddressLookupTableAccount[],
  units: number,
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
  }).compileToV0Message([...lookupTables]);
  return new VersionedTransaction(message);
}

export interface PreparedTx {
  readonly transaction: VersionedTransaction;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

/**
 * Sponsorun ödediği imzasız v0 tx. Compute unit sınırı simülasyonla ölçülür (imza denetimsiz): ölçüm %20 payla
 * yukarı yuvarlanır ve sponsorun tavanını aşamaz. Paketi aşan tx reddedilir.
 */
export async function prepareSponsoredTx(
  connection: Connection,
  params: {
    sponsor: PublicKey;
    instructions: readonly TransactionInstruction[];
    lookupTables?: readonly AddressLookupTableAccount[];
    /** Sponsorun tx başına compute unit tavanı (`/v1/sponsor/info`). */
    maxComputeUnits: number;
  },
): Promise<PreparedTx> {
  const tables = params.lookupTables ?? [];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const probe = compile(params.sponsor, blockhash, params.instructions, tables, MAX_COMPUTE_UNITS);
  if (!fits(probe)) throw new Error(`The transaction does not fit in a packet (${PACKET_DATA_SIZE} bytes).`);
  const { value } = await connection.simulateTransaction(probe, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });
  if (value.err) {
    throw new SimulationError(value.err, value.logs ?? []);
  }
  const measured = value.unitsConsumed ?? 0;
  const units = Math.max(COMPUTE_FLOOR, Math.ceil(measured * COMPUTE_MARGIN));
  if (units > params.maxComputeUnits) {
    throw new Error(
      `The transaction needs about ${units} compute units; the sponsor pays for at most ${params.maxComputeUnits}.`,
    );
  }
  return {
    transaction: compile(params.sponsor, blockhash, params.instructions, tables, units),
    blockhash,
    lastValidBlockHeight,
  };
}

/** Simülasyonda düşen tx: zincir hatası ve program günlüğü. */
export class SimulationError extends Error {
  constructor(
    readonly error: unknown,
    readonly logs: readonly string[],
  ) {
    super(`The transaction fails in simulation: ${JSON.stringify(error)}`);
    this.name = 'SimulationError';
  }
}

/** Tx'in ücret ödeyicisi (ilk statik hesap). */
export const feePayerOf = (transaction: VersionedTransaction): PublicKey => transaction.message.staticAccountKeys[0]!;
