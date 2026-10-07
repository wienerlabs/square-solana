// Sponsor politikası (ADR 0019): kullanıcının tx'i imzalanmadan önce çözülür ve denetlenir. Kurallar:
// 1. Yalnızca v0 tx; ücret ödeyicisi sponsor anahtarıdır.
// 2. Address lookup table'lar zincirden çözülür; denetim tx'in bütün hesaplarıyla yapılır.
// 3. Her talimatın programı ve talimatı izin listesindedir (`<program>:<talimat>`, discriminator ya da indeksle).
// 4. Sponsor anahtarı, ücret ödeyiciliği dışında yalnızca talimatın "ödeyici" yerlerinde durabilir (catalog.ts:
//    Square `payer` / `rent_payer`, ATA `payer`, Squads `creator` / `rent_payer`). System talimatında sponsor
//    hiç duramaz (SOL boşaltma); başka herhangi bir yerde (imzacı, yazılabilir hesap, yetkili) tx reddedilir.
// 5. Squads vault tx'lerinin iç mesajı (`vault_transaction_create`'in argümanı ya da yürütmede zincirdeki
//    VaultTransaction hesabı) aynı kurallarla denetlenir; iç mesajda compute budget ve Squads talimatı olmaz,
//    lookup table kullanılmaz. Yürütmenin kalan hesapları mesajın hesaplarıyla birebir aynı olmalıdır.
// 6. Compute unit fiyatı ve sınırı tavanın altındadır; aynı compute budget talimatı iki kez geçmez.
// 7. Tx en az bir Square ya da Squads talimatı taşır: sponsor genel amaçlı aktarımların ücretini ödemez.
// 8. Sponsor dışındaki imzalar, verilmişse geçerlidir; gönderim isteniyorsa hepsi verilmiş olmalıdır.
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  SQUADS_INSTRUCTIONS,
  SQUADS_MULTISIG_DISCRIMINATOR,
  decodeVaultTransactionAccount,
  decodeVaultTransactionCreate,
  type VaultMessage,
} from '@squaresdk/solana-sdk/squads';
import * as sqds from '@sqds/multisig';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { identify, type KnownInstruction, type ProgramKind } from './catalog.js';

export type RejectionReason =
  | 'unsupported_version'
  | 'fee_payer_mismatch'
  | 'invalid_signature'
  | 'missing_signatures'
  | 'lookup_table_not_found'
  | 'program_not_allowed'
  | 'instruction_not_allowed'
  | 'sponsor_drain'
  | 'sponsor_account_misuse'
  | 'duplicate_compute_budget'
  | 'compute_unit_price_too_high'
  | 'compute_unit_limit_too_high'
  | 'invalid_squads_message'
  | 'inner_lookup_table'
  | 'squads_transaction_not_found'
  | 'squads_accounts_mismatch'
  | 'squads_multisig_not_found'
  | 'sponsor_rent_unbounded'
  | 'sponsor_rent_extractable'
  | 'no_square_instruction';

/** Politikanın reddi: sebep kodu metrik etiketi ve yanıttaki `details.reason`'dır. */
export class PolicyRejection extends Error {
  constructor(
    readonly reason: RejectionReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PolicyRejection';
  }
}

export interface PolicyContext {
  readonly sponsor: PublicKey;
  /** Program kimliği (base58) → tür. */
  readonly programs: ReadonlyMap<string, ProgramKind>;
  readonly allowed: ReadonlySet<string>;
  readonly maxComputeUnitPrice: bigint;
  readonly maxComputeUnitLimit: number;
  /** Zincirdeki lookup table; yoksa null. */
  lookupTable(address: PublicKey): Promise<AddressLookupTableAccount | null>;
  /** Squads'a ait hesabın verisi; yoksa ya da sahibi Squads değilse null. */
  squadsAccount(address: PublicKey): Promise<Uint8Array | null>;
}

export interface Inspection {
  /** Denetlenen talimatlar (`<program>:<talimat>`); vault tx'inin içindekiler `vault>` önekiyle. */
  readonly instructions: readonly string[];
  readonly computeUnitLimit: number;
  /** Mikro-lamport / CU. */
  readonly computeUnitPrice: bigint;
  /** İmzası beklenen sponsor dışı hesaplar ve verilip verilmedikleri. */
  readonly signers: readonly { readonly key: string; readonly signed: boolean }[];
  readonly sponsoredTokenAccounts: number;
}

/** Talimat başına varsayılan compute unit sınırı ve tx tavanı (runtime). */
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000;
const MAX_TX_UNITS = 1_400_000;

interface Resolved {
  readonly programId: PublicKey;
  readonly accounts: readonly PublicKey[];
  readonly data: Uint8Array;
}

const allZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

export async function inspectTransaction(
  tx: VersionedTransaction,
  ctx: PolicyContext,
  options: { requireAllSignatures: boolean },
): Promise<Inspection> {
  const message = tx.message;
  if (message.version !== 0) {
    throw new PolicyRejection('unsupported_version', 'yalnızca v0 tx sponsorlanır');
  }
  const staticKeys = message.staticAccountKeys;
  if (!staticKeys[0]?.equals(ctx.sponsor)) {
    throw new PolicyRejection('fee_payer_mismatch', 'tx’in ücret ödeyicisi sponsor anahtarı değil', {
      feePayer: staticKeys[0]?.toBase58() ?? null,
      sponsor: ctx.sponsor.toBase58(),
    });
  }
  const signers = checkSignatures(tx, options.requireAllSignatures);

  // Lookup table'lar: yazılabilir ve salt okunur adresler, v0 sırasıyla statik hesaplardan sonra.
  const writable: PublicKey[] = [];
  const readonly: PublicKey[] = [];
  for (const lookup of message.addressTableLookups) {
    const table = await ctx.lookupTable(lookup.accountKey);
    const pick = (index: number) => {
      const address = table?.state.addresses[index];
      if (!address) {
        throw new PolicyRejection('lookup_table_not_found', 'address lookup table ya da girdisi bulunamadı', {
          lookupTable: lookup.accountKey.toBase58(),
          index,
        });
      }
      return address;
    };
    writable.push(...lookup.writableIndexes.map(pick));
    readonly.push(...lookup.readonlyIndexes.map(pick));
  }
  const keys = [...staticKeys, ...writable, ...readonly];
  const instructions: Resolved[] = message.compiledInstructions.map((ix) => ({
    programId: keys[ix.programIdIndex]!,
    accounts: ix.accountKeyIndexes.map((index) => keys[index]!),
    data: ix.data,
  }));

  const names: string[] = [];
  const budget = { limit: null as number | null, price: null as bigint | null };
  const rent = { tokenAccounts: 0 };
  let squareOrSquads = false;
  for (const [position, ix] of instructions.entries()) {
    const kind = programKind(ix, ctx, false);
    const known = allowedInstruction(kind, ix, ctx, false);
    names.push(`${kind}:${known.name}`);
    if (kind === 'computeBudget') {
      computeBudget(known.name, ix.data, budget);
      continue;
    }
    if (kind === 'squads' || isSquare(kind)) squareOrSquads = true;
    if (kind === 'squads' && known.name === 'vault_transaction_execute') {
      // Sabit hesaplar ödeyici yeri taşımaz; kalan hesaplar iç mesajın hesaplarıdır ve orada denetlenir.
      const fixed = SQUADS_INSTRUCTIONS.vault_transaction_execute.accounts.length;
      checkSponsorSlots(ctx, kind, known, ix.accounts.slice(0, fixed), position);
      const inner = await executedMessage(ix, instructions, ctx);
      const remaining = ix.accounts.slice(fixed);
      if (
        remaining.length !== inner.accountKeys.length ||
        remaining.some((key, index) => !key.equals(inner.accountKeys[index]!))
      ) {
        throw new PolicyRejection('squads_accounts_mismatch', 'yürütmenin hesapları vault tx mesajıyla aynı değil', {
          instruction: position,
        });
      }
      names.push(...inspectVaultMessage(inner, ctx, rent));
      continue;
    }
    checkSponsorSlots(ctx, kind, known, ix.accounts, position);
    countTokenAccount(ctx, kind, known, ix, position, false, rent);
    if (kind === 'squads' && known.name === 'multisig_create_v2') checkCreatedMultisigRoles(ctx, ix, position);
    if (kind === 'squads') await checkRentCollector(ctx, known, ix, instructions, position);
    if (kind === 'squads' && known.name === 'vault_transaction_create') {
      names.push(...inspectVaultMessage(createdMessage(ix.data, position), ctx, null));
    }
  }
  if (!squareOrSquads) {
    throw new PolicyRejection('no_square_instruction', 'tx Square ya da Squads talimatı taşımıyor');
  }

  const others = instructions.filter((ix) => programKindOf(ix.programId, ctx) !== 'computeBudget').length;
  const computeUnitLimit = budget.limit ?? Math.min(MAX_TX_UNITS, DEFAULT_UNITS_PER_INSTRUCTION * others);
  const computeUnitPrice = budget.price ?? 0n;
  if (computeUnitPrice > ctx.maxComputeUnitPrice) {
    throw new PolicyRejection('compute_unit_price_too_high', 'compute unit fiyatı tavanın üstünde', {
      computeUnitPrice: computeUnitPrice.toString(),
      max: ctx.maxComputeUnitPrice.toString(),
    });
  }
  if (computeUnitLimit > ctx.maxComputeUnitLimit) {
    throw new PolicyRejection('compute_unit_limit_too_high', 'compute unit sınırı tavanın üstünde', {
      computeUnitLimit,
      max: ctx.maxComputeUnitLimit,
    });
  }
  return {
    instructions: names,
    computeUnitLimit,
    computeUnitPrice,
    signers,
    sponsoredTokenAccounts: rent.tokenAccounts,
  };
}

const isSquare = (kind: ProgramKind) =>
  kind === 'registry' || kind === 'policy' || kind === 'verifier' || kind === 'escrow';

const programKindOf = (programId: PublicKey, ctx: PolicyContext) => ctx.programs.get(programId.toBase58()) ?? null;

function programKind(ix: Resolved, ctx: PolicyContext, inner: boolean): ProgramKind {
  const kind = programKindOf(ix.programId, ctx);
  // Vault tx'inin içinde compute budget anlamsızdır, precompile CPI ile çağrılamaz; iç içe Squads akışı
  // sponsorlanmaz.
  if (!kind || (inner && (kind === 'computeBudget' || kind === 'squads' || kind === 'ed25519'))) {
    throw new PolicyRejection('program_not_allowed', 'program izin listesinde değil', {
      program: ix.programId.toBase58(),
      inner,
    });
  }
  return kind;
}

function allowedInstruction(kind: ProgramKind, ix: Resolved, ctx: PolicyContext, inner: boolean): KnownInstruction {
  const known = identify(kind, ix.data);
  if (!ctx.allowed.has(`${kind}:${known.name}`)) {
    throw new PolicyRejection('instruction_not_allowed', 'talimat izin listesinde değil', {
      instruction: `${kind}:${known.name}`,
      inner,
    });
  }
  return known;
}

/** Sponsor yalnızca talimatın ödeyici yerlerinde durabilir; System talimatında hiç duramaz. */
function checkSponsorSlots(
  ctx: PolicyContext,
  kind: ProgramKind,
  known: KnownInstruction,
  accounts: readonly PublicKey[],
  position: number,
  inner = false,
): void {
  for (const [index, account] of accounts.entries()) {
    if (!account.equals(ctx.sponsor) || known.payerSlots.has(index)) continue;
    const details = {
      instruction: `${kind}:${known.name}`,
      position,
      account: known.accounts[index] ?? index,
      inner,
    };
    if (kind === 'system') {
      throw new PolicyRejection('sponsor_drain', 'sponsor anahtarı bir System talimatında kullanılamaz', details);
    }
    throw new PolicyRejection(
      'sponsor_account_misuse',
      'sponsor anahtarı ücret ve rent dışında bir rolde kullanılamaz',
      details,
    );
  }
}

function computeBudget(name: string, data: Uint8Array, budget: { limit: number | null; price: bigint | null }): void {
  const bytes = Buffer.from(data);
  const duplicate = () =>
    new PolicyRejection('duplicate_compute_budget', 'compute budget talimatı birden çok kez', { instruction: name });
  if (name === 'set_compute_unit_limit') {
    if (budget.limit !== null) throw duplicate();
    budget.limit = bytes.length === 5 ? bytes.readUInt32LE(1) : Number.POSITIVE_INFINITY;
  } else if (name === 'set_compute_unit_price') {
    if (budget.price !== null) throw duplicate();
    budget.price = bytes.length === 9 ? bytes.readBigUInt64LE(1) : 2n ** 64n;
  }
}

function createdMessage(data: Uint8Array, position: number): VaultMessage {
  try {
    return decodeVaultTransactionCreate(data).message;
  } catch (error) {
    throw new PolicyRejection('invalid_squads_message', 'vault tx mesajı çözülemedi', {
      instruction: position,
      error: (error as Error).message,
    });
  }
}

/** Yürütülen mesaj: aynı tx'te açılan vault tx'i ya da zincirdeki VaultTransaction hesabı. */
async function executedMessage(ix: Resolved, all: readonly Resolved[], ctx: PolicyContext): Promise<VaultMessage> {
  const transaction = ix.accounts[2];
  if (!transaction) {
    throw new PolicyRejection('invalid_squads_message', 'vault_transaction_execute hesapları eksik');
  }
  for (const [position, other] of all.entries()) {
    if (
      programKindOf(other.programId, ctx) === 'squads' &&
      identify('squads', other.data).name === 'vault_transaction_create' &&
      other.accounts[1]?.equals(transaction)
    ) {
      return createdMessage(other.data, position);
    }
  }
  const data = await ctx.squadsAccount(transaction);
  if (!data) {
    throw new PolicyRejection('squads_transaction_not_found', 'VaultTransaction hesabı zincirde yok', {
      transaction: transaction.toBase58(),
    });
  }
  try {
    return decodeVaultTransactionAccount(data).message;
  } catch (error) {
    throw new PolicyRejection('invalid_squads_message', 'VaultTransaction hesabı çözülemedi', {
      transaction: transaction.toBase58(),
      error: (error as Error).message,
    });
  }
}

const sponsorPays = (ctx: PolicyContext, known: KnownInstruction, accounts: readonly PublicKey[]) =>
  [...known.payerSlots].some((slot) => accounts[slot]?.equals(ctx.sponsor) ?? false);

function countTokenAccount(
  ctx: PolicyContext,
  kind: ProgramKind,
  known: KnownInstruction,
  ix: Resolved,
  position: number,
  inner: boolean,
  rent: { tokenAccounts: number } | null,
): void {
  if (kind !== 'ata' || (known.name !== 'create' && known.name !== 'create_idempotent')) return;
  if (!ix.accounts[0]?.equals(ctx.sponsor)) return;
  if (ix.accounts[5]?.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new PolicyRejection(
      'sponsor_rent_unbounded',
      'Token-2022 hesabının boyutu mint’in uzantılarına bağlıdır; sponsor bu hesabın rent’ini ödemez',
      { instruction: `${kind}:${known.name}`, position, inner },
    );
  }
  if (rent) rent.tokenAccounts += 1;
}

function decoded<T>(decode: () => T, details: Record<string, unknown>): T {
  try {
    return decode();
  } catch (error) {
    throw new PolicyRejection('invalid_squads_message', 'Squads verisi çözülemedi', {
      ...details,
      error: (error as Error).message,
    });
  }
}

const createdMultisig = (data: Uint8Array, position: number) =>
  decoded(() => sqds.generated.multisigCreateV2Struct.deserialize(Buffer.from(data))[0].args, {
    instruction: position,
  });

const createdRentCollector = (data: Uint8Array, position: number) => createdMultisig(data, position).rentCollector;

function checkCreatedMultisigRoles(ctx: PolicyContext, ix: Resolved, position: number): void {
  const args = createdMultisig(ix.data, position);
  const roles = [args.configAuthority, ...args.members.map((member) => member.key)];
  if (roles.some((role) => role?.equals(ctx.sponsor) ?? false)) {
    throw new PolicyRejection('sponsor_account_misuse', 'sponsor multisig’in üyesi ya da config yetkilisi olamaz', {
      instruction: 'squads:multisig_create_v2',
      position,
    });
  }
}

async function checkRentCollector(
  ctx: PolicyContext,
  known: KnownInstruction,
  ix: Resolved,
  all: readonly Resolved[],
  position: number,
): Promise<void> {
  if (!sponsorPays(ctx, known, ix.accounts)) return;
  let collector: PublicKey | null;
  if (known.name === 'multisig_create_v2') {
    collector = createdRentCollector(ix.data, position);
  } else if (known.name === 'vault_transaction_create' || known.name === 'proposal_create') {
    collector = await multisigRentCollector(ix.accounts[0], all, ctx, position);
  } else {
    return;
  }
  if (collector !== null && !collector.equals(ctx.sponsor)) {
    throw new PolicyRejection(
      'sponsor_rent_extractable',
      'sponsorun ödediği rent multisig’in rent_collector’ına döner; rent_collector yok ya da sponsor olmalı',
      { instruction: `squads:${known.name}`, position, rentCollector: collector.toBase58() },
    );
  }
}

async function multisigRentCollector(
  multisig: PublicKey | undefined,
  all: readonly Resolved[],
  ctx: PolicyContext,
  position: number,
): Promise<PublicKey | null> {
  if (!multisig) throw new PolicyRejection('invalid_squads_message', 'Squads talimatının multisig hesabı yok');
  for (const other of all) {
    if (
      programKindOf(other.programId, ctx) === 'squads' &&
      identify('squads', other.data).name === 'multisig_create_v2' &&
      other.accounts[2]?.equals(multisig)
    ) {
      return createdRentCollector(other.data, position);
    }
  }
  const data = await ctx.squadsAccount(multisig);
  if (!data || !Buffer.from(data.subarray(0, 8)).equals(Buffer.from(SQUADS_MULTISIG_DISCRIMINATOR))) {
    throw new PolicyRejection('squads_multisig_not_found', 'multisig hesabı zincirde yok', {
      multisig: multisig.toBase58(),
      instruction: position,
    });
  }
  return decoded(() => sqds.accounts.Multisig.deserialize(Buffer.from(data))[0].rentCollector, {
    multisig: multisig.toBase58(),
  });
}

/** Vault tx mesajının talimatları dış talimatlarla aynı kurallarla; lookup table kullanılamaz. */
function inspectVaultMessage(
  message: VaultMessage,
  ctx: PolicyContext,
  rent: { tokenAccounts: number } | null,
): string[] {
  if (message.addressTableLookups.length > 0) {
    throw new PolicyRejection('inner_lookup_table', 'vault tx mesajı address lookup table kullanamaz');
  }
  return message.instructions.map((compiled, position) => {
    const ix: Resolved = {
      programId: message.accountKeys[compiled.programIdIndex]!,
      accounts: compiled.accountIndexes.map((index) => message.accountKeys[index]!),
      data: compiled.data,
    };
    const kind = programKind(ix, ctx, true);
    const known = allowedInstruction(kind, ix, ctx, true);
    checkSponsorSlots(ctx, kind, known, ix.accounts, position, true);
    countTokenAccount(ctx, kind, known, ix, position, true, rent);
    return `vault>${kind}:${known.name}`;
  });
}

/** Ed25519 doğrulaması; kodlaması bozuk imza geçersizdir. */
function verify(signature: Uint8Array, message: Uint8Array, key: PublicKey): boolean {
  try {
    return ed25519.verify(signature, message, key.toBytes());
  } catch {
    return false;
  }
}

/** Sponsor dışındaki imzalar: verilmişse geçerli olmalı, gönderimde hepsi verilmiş olmalı. */
function checkSignatures(tx: VersionedTransaction, requireAll: boolean) {
  const message = tx.message;
  const bytes = message.serialize();
  const required = message.header.numRequiredSignatures;
  const signers = message.staticAccountKeys.slice(1, required).map((key, offset) => {
    const signature = tx.signatures[offset + 1];
    const signed = signature !== undefined && !allZero(signature);
    if (signed && !verify(signature, bytes, key)) {
      throw new PolicyRejection('invalid_signature', 'imza geçersiz', { signer: key.toBase58() });
    }
    return { key: key.toBase58(), signed };
  });
  const missing = signers.filter((signer) => !signer.signed).map((signer) => signer.key);
  if (requireAll && missing.length > 0) {
    throw new PolicyRejection('missing_signatures', 'gönderim için bütün imzalar gerekli', { missing });
  }
  return signers;
}
