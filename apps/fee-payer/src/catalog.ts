// Talimat kataloğu: sponsorlu bir tx'te tanınan programlar ve talimatları, her talimatın sponsor anahtarının
// durabileceği "ödeyici" hesap yerleri (ADR 0019). Ad biçimi `<program>:<talimat>`, talimat adları programın
// kendi adlarıdır (snake_case):
// - Square programları: IDL'deki discriminator'lar ve hesap adları; ödeyici yerleri `payer` (rent öder) ve
//   `rent_payer` (rent'in döndüğü hesap).
// - Squads v4: `@squaresdk/solana-sdk/squads` tablosu; ödeyici yerleri `creator` (multisig_create_v2: rent ve
//   oluşturma ücreti) ve `rent_payer`.
// - Associated Token Account: `create` / `create_idempotent`, ödeyici yeri `payer` (0. hesap).
// - System, SPL Token, Token-2022: talimat indeksleri; ödeyici yeri yoktur (sponsor bu talimatların hiçbir
//   hesabında duramaz).
// - Compute Budget: hesapsız; fiyat ve sınır tavanla denetlenir.
// - Ed25519 precompile: hesapsız; yalnızca tek imzalı doğrulama (`verify`) tanınır. Fiat rayında MPP
//   attestation'ı `verify_mpp_payment_proof`'tan hemen önce gelir (ADR 0024). İmza sayısı ücreti artırdığından
//   çok imzalı talimat tanınmaz.
import { SQUARE_IDLS, type SquareProgramIds, type SquareProgramName } from '@squaresdk/solana-sdk';
import { SQUADS_INSTRUCTIONS, SQUADS_PROGRAM_ID, squadsInstructionName } from '@squaresdk/solana-sdk/squads';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ComputeBudgetProgram, Ed25519Program, SystemProgram, type PublicKey } from '@solana/web3.js';

export type ProgramKind =
  SquareProgramName | 'squads' | 'system' | 'token' | 'token2022' | 'ata' | 'computeBudget' | 'ed25519';

export const SQUARE_PROGRAMS: readonly SquareProgramName[] = ['registry', 'policy', 'verifier', 'escrow'];

/** Tanınan talimat: adı ve sponsorun durabileceği hesap indeksleri. */
export interface KnownInstruction {
  readonly name: string;
  /** Hesap adları (biliniyorsa), talimattaki sırayla. */
  readonly accounts: readonly string[];
  readonly payerSlots: ReadonlySet<number>;
}

/** Tanınmayan talimatın adı: discriminator ya da indeks onaltılık (`#…`). */
export const unknownName = (data: Uint8Array, bytes: number) =>
  `#${Buffer.from(data.subarray(0, bytes)).toString('hex')}`;

const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const PAYER_NAMES = new Set(['payer', 'rent_payer']);

const slots = (accounts: readonly string[], names: ReadonlySet<string>) =>
  new Set(accounts.flatMap((account, index) => (names.has(account) ? [index] : [])));

interface IdlInstructionJson {
  name: string;
  discriminator: number[];
  accounts: { name: string }[];
}

/** Square programının talimatları discriminator'larıyla (IDL JSON'u). */
function squareTable(program: SquareProgramName): Map<string, KnownInstruction> {
  const idl = SQUARE_IDLS[program] as unknown as { instructions: IdlInstructionJson[] };
  return new Map(
    idl.instructions.map((ix) => {
      const accounts = ix.accounts.map((account) => toSnake(account.name));
      return [
        Buffer.from(ix.discriminator).toString('hex'),
        { name: toSnake(ix.name), accounts, payerSlots: slots(accounts, PAYER_NAMES) },
      ];
    }),
  );
}

const SQUARE_TABLES = Object.fromEntries(SQUARE_PROGRAMS.map((name) => [name, squareTable(name)])) as Record<
  SquareProgramName,
  Map<string, KnownInstruction>
>;

const SQUADS_PAYERS: Readonly<Record<string, ReadonlySet<string>>> = {
  multisig_create_v2: new Set(['creator']),
  vault_transaction_create: new Set(['rent_payer']),
  proposal_create: new Set(['rent_payer']),
};

/** System programı talimat indeksleri (`SystemInstruction`, u32 LE). */
const SYSTEM_NAMES: readonly string[] = [
  'create_account',
  'assign',
  'transfer',
  'create_account_with_seed',
  'advance_nonce_account',
  'withdraw_nonce_account',
  'initialize_nonce_account',
  'authorize_nonce_account',
  'allocate',
  'allocate_with_seed',
  'assign_with_seed',
  'transfer_with_seed',
  'upgrade_nonce_account',
];

/** SPL Token ve Token-2022'nin ortak talimat indeksleri (`TokenInstruction`, u8). */
const TOKEN_NAMES: readonly string[] = [
  'initialize_mint',
  'initialize_account',
  'initialize_multisig',
  'transfer',
  'approve',
  'revoke',
  'set_authority',
  'mint_to',
  'burn',
  'close_account',
  'freeze_account',
  'thaw_account',
  'transfer_checked',
  'approve_checked',
  'mint_to_checked',
  'burn_checked',
  'initialize_account2',
  'sync_native',
  'initialize_account3',
];

const ATA_NAMES: readonly string[] = ['create', 'create_idempotent', 'recover_nested'];
const COMPUTE_BUDGET_NAMES: Readonly<Record<number, string>> = {
  1: 'request_heap_frame',
  2: 'set_compute_unit_limit',
  3: 'set_compute_unit_price',
  4: 'set_loaded_accounts_data_size_limit',
};

/** Ed25519 precompile'ın tek imzalı doğrulaması (ilk bayt imza sayısı). */
const ED25519_VERIFY = 'verify';

const NONE: ReadonlySet<number> = new Set();
const plain = (name: string): KnownInstruction => ({ name, accounts: [], payerSlots: NONE });

/** Programın talimat verisinden adı ve ödeyici yerleri. */
export function identify(kind: ProgramKind, data: Uint8Array): KnownInstruction {
  switch (kind) {
    case 'registry':
    case 'policy':
    case 'verifier':
    case 'escrow':
      return SQUARE_TABLES[kind].get(Buffer.from(data.subarray(0, 8)).toString('hex')) ?? plain(unknownName(data, 8));
    case 'squads': {
      const name = squadsInstructionName(data);
      if (!name) return plain(unknownName(data, 8));
      const accounts = SQUADS_INSTRUCTIONS[name].accounts;
      return { name, accounts, payerSlots: slots(accounts, SQUADS_PAYERS[name] ?? new Set()) };
    }
    case 'system': {
      const index = data.length >= 4 ? Buffer.from(data).readUInt32LE(0) : -1;
      return plain(SYSTEM_NAMES[index] ?? unknownName(data, 4));
    }
    case 'token':
    case 'token2022':
      return plain(TOKEN_NAMES[data[0] ?? -1] ?? unknownName(data, 1));
    case 'ata': {
      // Verisi boş talimat `create`'tir (eski biçim).
      const name = data.length === 0 ? 'create' : ATA_NAMES[data[0]!];
      if (!name) return plain(unknownName(data, 1));
      return {
        name,
        accounts: ['payer', 'associated_token', 'owner', 'mint', 'system_program', 'token_program'],
        payerSlots: new Set([0]),
      };
    }
    case 'computeBudget':
      return plain(COMPUTE_BUDGET_NAMES[data[0] ?? -1] ?? unknownName(data, 1));
    case 'ed25519':
      return plain(data[0] === 1 ? ED25519_VERIFY : unknownName(data, 1));
  }
}

/** Bir kümedeki program kimliği → tür. */
export function programKinds(programIds: SquareProgramIds): ReadonlyMap<string, ProgramKind> {
  const entries: [PublicKey, ProgramKind][] = [
    ...SQUARE_PROGRAMS.map((name): [PublicKey, ProgramKind] => [programIds[name], name]),
    [SQUADS_PROGRAM_ID, 'squads'],
    [SystemProgram.programId, 'system'],
    [TOKEN_PROGRAM_ID, 'token'],
    [TOKEN_2022_PROGRAM_ID, 'token2022'],
    [ASSOCIATED_TOKEN_PROGRAM_ID, 'ata'],
    [ComputeBudgetProgram.programId, 'computeBudget'],
    [Ed25519Program.programId, 'ed25519'],
  ];
  return new Map(entries.map(([id, kind]) => [id.toBase58(), kind]));
}

/** Her türün bilinen talimat adları (izin listesinin doğrulaması için). */
function knownNames(kind: ProgramKind): readonly string[] {
  switch (kind) {
    case 'registry':
    case 'policy':
    case 'verifier':
    case 'escrow':
      return [...SQUARE_TABLES[kind].values()].map((ix) => ix.name);
    case 'squads':
      return Object.keys(SQUADS_INSTRUCTIONS);
    case 'system':
      return SYSTEM_NAMES;
    case 'token':
    case 'token2022':
      return TOKEN_NAMES;
    case 'ata':
      return ATA_NAMES;
    case 'computeBudget':
      return Object.values(COMPUTE_BUDGET_NAMES);
    case 'ed25519':
      return [ED25519_VERIFY];
  }
}

const KINDS: readonly ProgramKind[] = [
  ...SQUARE_PROGRAMS,
  'squads',
  'system',
  'token',
  'token2022',
  'ata',
  'computeBudget',
  'ed25519',
];

/**
 * Varsayılan izin listesi (ADR 0019): 8 adımın, fiat rayının (ADR 0024) ve kullanıcı tarafı dispute / iptal
 * akışlarının Square talimatları, MPP attestation'ının Ed25519 doğrulaması, smart account kurulumu ve vault tx akışı,
 * ATA açılışı, compute budget ve kullanıcı fonlu aktarımlar.
 * Yönetici talimatları (`init_*config`, `update_registry_config`, `update_params`, `update_arbitrators`,
 * `update_mpp_authority`), screener (`record_screening`), hakem (`resolve_dispute`) ve CPI'ye özel
 * `record_release` listede yoktur.
 */
export const DEFAULT_ALLOWED_INSTRUCTIONS: readonly string[] = Object.freeze([
  'registry:register_agent',
  'registry:update_agent',
  'registry:set_agent_status',
  'registry:transfer_agent_ownership',
  'registry:deregister_agent',
  'policy:init_institution',
  'policy:set_policy',
  'policy:update_policy',
  'policy:set_buyer_root',
  'policy:set_institution_multisig',
  'policy:deactivate_policy',
  'verifier:set_compliance_proof',
  'verifier:set_preflight_proof',
  'verifier:verify_mpp_payment_proof',
  'escrow:create_job',
  'escrow:create_fiat_job',
  'escrow:commit_travel_rule',
  'escrow:fund_job',
  'escrow:accept_job',
  'escrow:submit_work',
  'escrow:list_claim',
  'escrow:buy_claim',
  'escrow:cancel_claim',
  'escrow:cancel_job',
  'escrow:cancel_fiat_job',
  'escrow:finalize_payment',
  'escrow:finalize_fiat_payment',
  'escrow:raise_dispute',
  'escrow:execute_resolution',
  'escrow:lapse_dispute',
  'escrow:escalate_missing_proof',
  'escrow:sync_agent_wallet',
  'squads:multisig_create_v2',
  'squads:vault_transaction_create',
  'squads:proposal_create',
  'squads:proposal_approve',
  'squads:vault_transaction_execute',
  'ata:create',
  'ata:create_idempotent',
  'computeBudget:set_compute_unit_limit',
  'computeBudget:set_compute_unit_price',
  'ed25519:verify',
  'system:transfer',
  'token:transfer_checked',
  'token2022:transfer_checked',
]);

/** `<program>:<talimat>` listesi; bilinmeyen program ya da talimat reddedilir. */
export function parseAllowedInstructions(value: string): ReadonlySet<string> {
  const entries = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error('en az bir talimat gerekli');
  for (const entry of entries) {
    const [kind, name, ...rest] = entry.split(':');
    if (rest.length > 0 || !kind || !name || !KINDS.includes(kind as ProgramKind)) {
      throw new Error(`"${entry}" <program>:<talimat> değil (programlar: ${KINDS.join(', ')})`);
    }
    if (!knownNames(kind as ProgramKind).includes(name)) throw new Error(`${kind} programında ${name} yok`);
  }
  return new Set(entries);
}
