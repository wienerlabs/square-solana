// Ağ sayfası (FE-11): Square programlarının zincirdeki durumu. Programın deploy'u ve upgrade authority'si BPF
// upgradeable loader'ın hesaplarından okunur. Config hesapları program sözleşmesindeki (JSON IDL, BC-44) alan adı,
// sırası ve açıklamasıyla gösterilir: alan listesi kodda tutulmaz, IDL'den gelir; adlar sözleşmedeki gibi
// snake_case'tir (`keeper_fee_bps`). Square ALT'ının içeriği SDK'nın
// beklediği adreslerle (`squareLookupTableAddresses`) karşılaştırılır. Hepsi zincirden; indexer gerekmez.
import { BorshAccountsCoder, type Idl, type IdlField, type IdlType, type IdlTypeDef } from '@anchor-lang/core';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, type Connection } from '@solana/web3.js';
import { createPda, squareLookupTableAddresses, SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { ProgramName } from './config';
import { escrowConfigAddress, registryConfigAddress, verifierConfigAddress } from './idl-pda';
import { formatDuration } from './job-wizard';
import { formatUnits } from './settlement';

/** BPF upgradeable loader; Square programları bununla deploy edilir (web3.js bu kimliği dışa vermez). */
export const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** `UpgradeableLoaderState` (bincode): u32 etiket, ardından varyantın alanları. */
const PROGRAM_TAG = 2;
const PROGRAM_DATA_TAG = 3;
/** `ProgramData` başlığı: etiket (4), `slot` (8), `Option<Pubkey>` upgrade authority (1 + 32). Kod bundan sonradır. */
export const PROGRAM_DATA_HEADER_SIZE = 45;

const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** Program hesabındaki `programdata_address` (`UpgradeableLoaderState::Program`). */
export function programDataAddressOf(data: Uint8Array): PublicKey {
  if (data.length < 36 || view(data).getUint32(0, true) !== PROGRAM_TAG) {
    throw new Error('Not an upgradeable loader program account');
  }
  return new PublicKey(data.subarray(4, 36));
}

/** Program data hesabının başlığı (`UpgradeableLoaderState::ProgramData`): son deploy'un slot'u ve authority. */
export function programDataHeader(data: Uint8Array): { slot: number; authority: PublicKey | null } {
  if (data.length < 13 || view(data).getUint32(0, true) !== PROGRAM_DATA_TAG) {
    throw new Error('Not an upgradeable loader program data account');
  }
  const slot = Number(view(data).getBigUint64(4, true));
  if (data[12] === 0) return { slot, authority: null };
  if (data[12] !== 1 || data.length < PROGRAM_DATA_HEADER_SIZE) throw new Error('Malformed program data header');
  return { slot, authority: new PublicKey(data.subarray(13, PROGRAM_DATA_HEADER_SIZE)) };
}

export type ProgramDeployment =
  | { state: 'missing' }
  /** Hesap var ama program değil. */
  | { state: 'notProgram'; owner: string }
  /** Başka bir loader'ın programı: upgradeable loader'ın authority'si yoktur. */
  | { state: 'otherLoader'; loader: string }
  /** Program hesabı duruyor, program data hesabı kapatılmış (`solana program close`). */
  | { state: 'closed'; programData: string }
  /** `authority` null ise program değiştirilemez (immutable). */
  | { state: 'upgradeable'; programData: string; deploySlot: number; authority: string | null };

/** Programın deploy durumu; program data'nın yalnızca başlığı okunur (kod okunmaz). */
export async function readProgramDeployment(connection: Connection, programId: PublicKey): Promise<ProgramDeployment> {
  const account = await connection.getAccountInfo(programId, 'confirmed');
  if (!account) return { state: 'missing' };
  if (!account.executable) return { state: 'notProgram', owner: account.owner.toBase58() };
  if (!account.owner.equals(UPGRADEABLE_LOADER)) return { state: 'otherLoader', loader: account.owner.toBase58() };
  const programData = programDataAddressOf(account.data);
  const header = await connection.getAccountInfo(programData, {
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER_SIZE },
  });
  if (!header) return { state: 'closed', programData: programData.toBase58() };
  const { slot, authority } = programDataHeader(header.data);
  return {
    state: 'upgradeable',
    programData: programData.toBase58(),
    deploySlot: slot,
    authority: upgradeAuthority(authority),
  };
}

/**
 * Upgrade authority; yoksa null. Sıfır adres de yetkisizdir: onun için kimse imza atamaz (solana-test-validator
 * `--bpf-program` ile yüklenen programa bunu yazar).
 */
export function upgradeAuthority(authority: PublicKey | null): string | null {
  return authority && !authority.equals(PublicKey.default) ? authority.toBase58() : null;
}

// ------------------------------------------------------------------ config hesapları

/** Config'i olan programlar ve hesabın IDL'deki adı; square_policy'nin config'i yoktur (hesapları kurum başınadır). */
export const CONFIG_ACCOUNTS = {
  registry: 'RegistryConfig',
  verifier: 'VerifierConfig',
  escrow: 'EscrowConfig',
} as const satisfies Partial<Record<ProgramName, string>>;

export type ConfigProgram = keyof typeof CONFIG_ACCOUNTS;

const CONFIG_ADDRESS: Readonly<Record<ConfigProgram, (programId: PublicKey) => PublicKey>> = {
  registry: registryConfigAddress,
  verifier: verifierConfigAddress,
  escrow: escrowConfigAddress,
};

export const configAddress = (program: ConfigProgram, programId: PublicKey) => CONFIG_ADDRESS[program](programId);

export type ConfigAccount =
  { address: string; state: 'uninitialized' } | { address: string; state: 'ready'; value: Record<string, unknown> };

/** Config hesabını JSON IDL'in coder'ıyla çözer (alan adları snake_case); hesap yoksa (init edilmemiş) `uninitialized`. */
export async function readConfig(
  connection: Connection,
  program: ConfigProgram,
  programId: PublicKey,
): Promise<ConfigAccount> {
  const address = configAddress(program, programId);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info) return { address: address.toBase58(), state: 'uninitialized' };
  if (!info.owner.equals(programId)) throw new Error(`${address.toBase58()} is not owned by the program`);
  const coder = new BorshAccountsCoder(SQUARE_IDLS[program] as Idl);
  const value = coder.decode<Record<string, unknown>>(CONFIG_ACCOUNTS[program], info.data);
  return { address: address.toBase58(), state: 'ready', value };
}

export interface ConfigEntry {
  /** IDL'deki alan adı. */
  name: string;
  /** IDL'deki açıklama (programın doc yorumu); yoksa boş. */
  docs: string;
  /** Biçimlenmiş değer; adres alanlarında ve iç içe yapılarda null. */
  text: string | null;
  /** Adres alanının ya da adres listesinin değerleri. */
  addresses: string[];
  /** İç içe yapının alanları (ör. `EscrowParams`). */
  fields: ConfigEntry[] | null;
}

export interface FormatContext {
  /** Settlement mint'inin ondalığı; bilinmiyorsa tutarlar taban birimiyle gösterilir. */
  decimals: number | null;
}

/** Ad kuralları (IDL): `*_bps` baz puan, `*_secs` ve `*_period` saniye. */
const BPS = /_bps$/;
const SECONDS = /_(secs|period)$/;
/** Settlement mint'inin biriminde tutar olan alanlar (`EscrowParams`); `travel_rule_threshold` 0 ise kapalıdır. */
const TOKEN_AMOUNTS = new Set(['min_bond_absolute', 'travel_rule_threshold']);
/** Yuvaların yalnızca bir kısmı etkin olan diziler: `arbitrators[..arbitrator_count]` (IDL'deki açıklama). */
const ACTIVE_SLOTS: Readonly<Record<string, string>> = { arbitrators: 'arbitrator_count' };
const INTEGER = /^[ui](8|16|32|64|128)$/;

const toBase58 = (value: unknown) => (value as PublicKey).toBase58();

function typeDef(idl: Idl, name: string): IdlTypeDef {
  const def = idl.types?.find((type) => type.name === name);
  if (!def) throw new Error(`${idl.metadata.name} IDL has no ${name} type`);
  return def;
}

/** Baz puan yüzde olarak: 50 → "0.5%". */
export const formatBps = (bps: bigint) =>
  `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

function formatScalar(name: string, type: IdlType, value: unknown, { decimals }: FormatContext): string {
  if (type === 'bool') return value ? 'Yes' : 'No';
  if (type === 'string') return String(value);
  if (typeof type === 'string' && INTEGER.test(type)) {
    const amount = BigInt(String(value));
    if (BPS.test(name)) return `${amount} bps (${formatBps(amount)})`;
    if (SECONDS.test(name)) return amount > 0n ? `${formatDuration(amount)} (${amount} s)` : `${amount} s`;
    if (TOKEN_AMOUNTS.has(name)) {
      if (name === 'travel_rule_threshold' && amount === 0n) return 'Disabled (0)';
      return decimals === null
        ? `${amount} base units`
        : `${formatUnits(amount, decimals)} USDC (${amount} base units)`;
    }
    return amount.toString();
  }
  if (typeof type === 'object' && 'array' in type && type.array[0] === 'u8') {
    return `0x${Array.from(value as number[], (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  if (typeof type === 'object' && 'option' in type) {
    return value === null ? 'None' : formatScalar(name, type.option, value, { decimals });
  }
  return JSON.stringify(value);
}

function entryOf(idl: Idl, field: IdlField, parent: Record<string, unknown>, context: FormatContext): ConfigEntry {
  const value = parent[field.name];
  const entry: ConfigEntry = {
    name: field.name,
    docs: (field.docs ?? []).join(' '),
    text: null,
    addresses: [],
    fields: null,
  };
  const { type } = field;
  if (type === 'pubkey') return { ...entry, addresses: [toBase58(value)] };
  if (typeof type === 'object' && 'array' in type && type.array[0] === 'pubkey') {
    const keys = (value as unknown[]).map(toBase58);
    const counter = ACTIVE_SLOTS[field.name];
    const active = counter === undefined ? keys.length : Number(parent[counter]);
    return { ...entry, addresses: keys.slice(0, active) };
  }
  if (typeof type === 'object' && 'defined' in type) {
    const def = typeDef(idl, type.defined.name);
    if (def.type.kind === 'struct') {
      return { ...entry, fields: structEntries(idl, type.defined.name, value as Record<string, unknown>, context) };
    }
    if (def.type.kind === 'enum') return { ...entry, text: Object.keys(value as Record<string, unknown>)[0] ?? '' };
  }
  return { ...entry, text: formatScalar(field.name, type, value, context) };
}

/** IDL'deki yapının alanları, IDL sırasıyla ve açıklamalarıyla. */
export function structEntries(
  idl: Idl,
  typeName: string,
  value: Record<string, unknown>,
  context: FormatContext,
): ConfigEntry[] {
  const def = typeDef(idl, typeName);
  if (def.type.kind !== 'struct' || !def.type.fields) throw new Error(`${typeName} is not a struct with fields`);
  return (def.type.fields as IdlField[]).map((field) => entryOf(idl, field, value, context));
}

/** Config hesabının alanları (`structEntries`, programın IDL'inden). */
export const configEntries = (program: ConfigProgram, value: Record<string, unknown>, context: FormatContext) =>
  structEntries(SQUARE_IDLS[program] as Idl, CONFIG_ACCOUNTS[program], value, context);

/** IDL'deki tipin açıklaması (ör. `EscrowConfig` → "Singleton. seeds = [\"config\"]"). */
export const typeDocs = (program: ConfigProgram) =>
  (typeDef(SQUARE_IDLS[program] as Idl, CONFIG_ACCOUNTS[program]).docs ?? []).join(' ');

/** IDL'deki yapı alanının açıklaması (ör. `EscrowParams.keeper_fee_bps`). */
export function fieldDocs(program: ProgramName, typeName: string, fieldName: string): string {
  const def = typeDef(SQUARE_IDLS[program] as Idl, typeName);
  const fields = def.type.kind === 'struct' ? ((def.type.fields ?? []) as IdlField[]) : [];
  const field = fields.find((entry) => entry.name === fieldName);
  if (!field) throw new Error(`${typeName} has no ${fieldName} field`);
  return (field.docs ?? []).join(' ');
}

// ------------------------------------------------------------------ address lookup table

export interface LookupTableState {
  /** Authority'si yoksa tablo dondurulmuştur: içeriği değişmez. */
  authority: string | null;
  /** Kapatılmak üzere devre dışı bırakılmamışsa true (`deactivation_slot == u64::MAX`). */
  active: boolean;
  lastExtendedSlot: number;
  addresses: string[];
}

export async function readLookupTable(connection: Connection, address: PublicKey): Promise<LookupTableState | null> {
  const { value } = await connection.getAddressLookupTable(address, { commitment: 'confirmed' });
  if (!value) return null;
  return {
    authority: value.state.authority?.toBase58() ?? null,
    active: value.isActive(),
    lastExtendedSlot: value.state.lastExtendedSlot,
    addresses: value.state.addresses.map((key) => key.toBase58()),
  };
}

export interface ExpectedEntry {
  address: string;
  /** Adresin ne olduğu: program, config PDA'sı, mint ya da sistem programı. */
  label: string;
}

/** SDK'nın beklediği ALT içeriği (`squareLookupTableAddresses`), sırasıyla ve adlarıyla. */
export function expectedLookupTable(
  programIds: Readonly<Record<ProgramName, PublicKey>>,
  settlementMint: PublicKey,
): ExpectedEntry[] {
  const pda = createPda(programIds);
  const labels = new Map<string, string>([
    [programIds.registry.toBase58(), 'square_registry program'],
    [programIds.policy.toBase58(), 'square_policy program'],
    [programIds.verifier.toBase58(), 'square_verifier program'],
    [programIds.escrow.toBase58(), 'square_escrow program'],
    [pda.registryConfig()[0].toBase58(), 'RegistryConfig'],
    [pda.escrowConfig()[0].toBase58(), 'EscrowConfig'],
    [pda.verifierConfig()[0].toBase58(), 'VerifierConfig'],
    [pda.escrowAuthority()[0].toBase58(), 'escrow_authority PDA'],
    [settlementMint.toBase58(), 'Settlement mint'],
    [SystemProgram.programId.toBase58(), 'System program'],
    [TOKEN_PROGRAM_ID.toBase58(), 'Token program'],
    [TOKEN_2022_PROGRAM_ID.toBase58(), 'Token-2022 program'],
    [SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(), 'Instructions sysvar'],
  ]);
  return squareLookupTableAddresses({ programIds, pda, settlementMint }).map((key) => {
    const address = key.toBase58();
    return { address, label: labels.get(address) ?? 'Square address' };
  });
}

export interface LookupTableCheck {
  /** Tablo beklenen adreslerin hepsini içeriyor ve fazlası yok. */
  matches: boolean;
  /** Beklenip tabloda olmayanlar: bu adreslere dokunan tx'ler tabloyla küçülmez. */
  missing: string[];
  /** Tabloda olup beklenmeyenler. */
  extra: string[];
}

/** Tx'ler adresleri tablodaki yerinden çözer; sıra değil üyelik önemlidir. */
export function checkLookupTable(stored: readonly string[], expected: readonly string[]): LookupTableCheck {
  const missing = expected.filter((address) => !stored.includes(address));
  const extra = stored.filter((address) => !expected.includes(address));
  return { matches: missing.length === 0 && extra.length === 0, missing, extra };
}
