import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  unpackMint,
  type Account as TokenAccount,
  type Mint,
} from '@solana/spl-token';
import { PublicKey, SystemProgram, type AccountInfo, type Connection } from '@solana/web3.js';
import type { AgentCapability, JobHandler } from '@squaresdk/solana-agent-sdk';
import { SQUARE_IDLS, specHashing, type SquareProgramIds, type SquareProgramName } from '@squaresdk/solana-sdk';

export const ACCOUNT_REPORT_ID = 'solana.account-report';
export const MAX_REPORT_ACCOUNTS = 8;
export const MAX_REPORT_SIGNATURES = 10;
export const DEFAULT_REPORT_SIGNATURES = 5;
const SOL_DECIMALS = 9;

export type ChainReader = Pick<
  Connection,
  | 'getSlot'
  | 'getBlockTime'
  | 'getMultipleAccountsInfo'
  | 'getSignaturesForAddress'
  | 'getMinimumBalanceForRentExemption'
>;

export interface ReportRequest {
  accounts: PublicKey[];
  signatures: number;
}

export type AccountKind = 'missing' | 'wallet' | 'program' | 'tokenAccount' | 'mint' | 'square' | 'other';

export interface TokenHolding {
  mint: string;
  owner: string;
  amount: string;
  decimals: number | null;
  uiAmount: string | null;
}

export interface MintSummary {
  supply: string;
  decimals: number;
  uiSupply: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface Activity {
  signatures: number;
  failed: number;
  newestSlot: number | null;
  newestBlockTime: string | null;
}

export interface AccountEntry {
  address: string;
  kind: AccountKind;
  lamports: string;
  sol: string;
  owner: string | null;
  ownerLabel: string | null;
  executable: boolean;
  dataBytes: number;
  rentExemptMinimum: string;
  rentExempt: boolean;
  token?: TokenHolding;
  mint?: MintSummary;
  square?: { program: string; account: string };
  activity?: Activity;
}

export interface TokenTotal {
  mint: string;
  accounts: number;
  amount: string;
  uiAmount: string | null;
}

export interface AccountReport {
  capability: typeof ACCOUNT_REPORT_ID;
  job: string;
  specHash: string;
  observedAt: { slot: number; blockTime: string | null };
  accounts: AccountEntry[];
  summary: {
    accounts: number;
    existing: number;
    missing: number;
    totalLamports: string;
    totalSol: string;
    kinds: Partial<Record<AccountKind, number>>;
    tokenTotals: TokenTotal[];
  };
}

const PROGRAM_CRATES: Readonly<Record<SquareProgramName, string>> = {
  registry: 'square_registry',
  policy: 'square_policy',
  verifier: 'square_verifier',
  escrow: 'square_escrow',
};

const WELL_KNOWN_PROGRAMS: Readonly<Record<string, string>> = {
  [SystemProgram.programId.toBase58()]: 'System Program',
  [TOKEN_PROGRAM_ID.toBase58()]: 'SPL Token',
  [TOKEN_2022_PROGRAM_ID.toBase58()]: 'Token-2022',
  [ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()]: 'Associated Token Account',
  BPFLoaderUpgradeab1e11111111111111111111111: 'BPF Loader (upgradeable)',
  BPFLoader2111111111111111111111111111111111: 'BPF Loader 2',
  NativeLoader1111111111111111111111111111111: 'Native Loader',
  Sysvar1111111111111111111111111111111111111: 'Sysvar',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = magnitude / base;
  const text = decimals === 0 ? whole.toString() : `${whole}.${(magnitude % base).toString().padStart(decimals, '0')}`;
  return negative ? `-${text}` : text;
}

const canonicalAddress = (value: unknown): PublicKey | null => {
  if (typeof value !== 'string') return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? key : null;
  } catch {
    return null;
  }
};

export function parseReportSpec(spec: unknown): ReportRequest {
  if (!isRecord(spec)) throw new Error('job spec bir JSON nesnesi olmalı');
  const { accounts, signatures } = spec;
  if (!Array.isArray(accounts) || accounts.length === 0 || accounts.length > MAX_REPORT_ACCOUNTS) {
    throw new Error(`spec.accounts 1 ile ${MAX_REPORT_ACCOUNTS} arası adres listesi olmalı`);
  }
  const keys = accounts.map((value, index) => {
    const key = canonicalAddress(value);
    if (!key) throw new Error(`spec.accounts[${index}] base58 Solana adresi değil`);
    return key;
  });
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) {
    throw new Error('spec.accounts tekrar eden adres içeriyor');
  }
  const count = signatures ?? DEFAULT_REPORT_SIGNATURES;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_REPORT_SIGNATURES) {
    throw new Error(`spec.signatures 0 ile ${MAX_REPORT_SIGNATURES} arası tamsayı olmalı`);
  }
  return { accounts: keys, signatures: count };
}

export function reportSpecError(spec: unknown): string | null {
  try {
    parseReportSpec(spec);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function squareAccountTypes(programIds: SquareProgramIds): Map<string, { program: string; account: string }> {
  const types = new Map<string, { program: string; account: string }>();
  for (const name of Object.keys(PROGRAM_CRATES) as SquareProgramName[]) {
    const idl = SQUARE_IDLS[name] as unknown as { accounts?: { name: string; discriminator: number[] }[] };
    for (const account of idl.accounts ?? []) {
      types.set(`${programIds[name].toBase58()}:${hex(Uint8Array.from(account.discriminator))}`, {
        program: PROGRAM_CRATES[name],
        account: account.name,
      });
    }
  }
  return types;
}

function ownerLabels(programIds: SquareProgramIds): Map<string, string> {
  const labels = new Map(Object.entries(WELL_KNOWN_PROGRAMS));
  for (const name of Object.keys(PROGRAM_CRATES) as SquareProgramName[]) {
    labels.set(programIds[name].toBase58(), PROGRAM_CRATES[name]);
  }
  return labels;
}

const isTokenProgram = (owner: PublicKey) => owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);

function tryUnpackToken(address: PublicKey, info: AccountInfo<Buffer>): TokenAccount | null {
  try {
    return unpackAccount(address, info, info.owner);
  } catch {
    return null;
  }
}

function tryUnpackMint(address: PublicKey, info: AccountInfo<Buffer>): Mint | null {
  try {
    return unpackMint(address, info, info.owner);
  } catch {
    return null;
  }
}

interface Decoded {
  kind: AccountKind;
  token?: TokenAccount;
  mint?: Mint;
  square?: { program: string; account: string };
}

function decode(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  squareTypes: Map<string, { program: string; account: string }>,
): Decoded {
  if (!info) return { kind: 'missing' };
  if (info.executable) return { kind: 'program' };
  if (info.owner.equals(SystemProgram.programId) && info.data.length === 0) return { kind: 'wallet' };
  if (isTokenProgram(info.owner)) {
    const token = tryUnpackToken(address, info);
    if (token) return { kind: 'tokenAccount', token };
    const mint = tryUnpackMint(address, info);
    if (mint) return { kind: 'mint', mint };
    return { kind: 'other' };
  }
  const square = squareTypes.get(`${info.owner.toBase58()}:${hex(info.data.subarray(0, 8))}`);
  return square ? { kind: 'square', square } : { kind: 'other' };
}

async function rentMinimums(reader: ChainReader, sizes: readonly number[]): Promise<Map<number, bigint>> {
  const minimums = new Map<number, bigint>();
  for (const size of new Set(sizes)) {
    minimums.set(size, BigInt(await reader.getMinimumBalanceForRentExemption(size)));
  }
  return minimums;
}

async function activityOf(reader: ChainReader, address: PublicKey, limit: number): Promise<Activity> {
  const signatures = await reader.getSignaturesForAddress(address, { limit });
  const newest = signatures[0];
  return {
    signatures: signatures.length,
    failed: signatures.filter((item) => item.err !== null).length,
    newestSlot: newest?.slot ?? null,
    newestBlockTime: newest?.blockTime ? new Date(newest.blockTime * 1000).toISOString() : null,
  };
}

async function referencedMints(
  reader: ChainReader,
  decoded: readonly Decoded[],
  requested: readonly PublicKey[],
): Promise<Map<string, Mint>> {
  const mints = new Map<string, Mint>();
  decoded.forEach((item, index) => {
    if (item.mint) mints.set(requested[index]!.toBase58(), item.mint);
  });
  const missing = [...new Set(decoded.flatMap((item) => (item.token ? [item.token.mint.toBase58()] : [])))].filter(
    (mint) => !mints.has(mint),
  );
  if (missing.length === 0) return mints;
  const keys = missing.map((mint) => new PublicKey(mint));
  const infos = await reader.getMultipleAccountsInfo(keys);
  infos.forEach((info, index) => {
    if (!info || !isTokenProgram(info.owner)) return;
    const mint = tryUnpackMint(keys[index]!, info);
    if (mint) mints.set(missing[index]!, mint);
  });
  return mints;
}

function holding(token: TokenAccount, mints: Map<string, Mint>): TokenHolding {
  const decimals = mints.get(token.mint.toBase58())?.decimals ?? null;
  return {
    mint: token.mint.toBase58(),
    owner: token.owner.toBase58(),
    amount: token.amount.toString(),
    decimals,
    uiAmount: decimals === null ? null : formatUnits(token.amount, decimals),
  };
}

function mintSummary(mint: Mint): MintSummary {
  return {
    supply: mint.supply.toString(),
    decimals: mint.decimals,
    uiSupply: formatUnits(mint.supply, mint.decimals),
    mintAuthority: mint.mintAuthority?.toBase58() ?? null,
    freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
  };
}

function tokenTotals(entries: readonly AccountEntry[]): TokenTotal[] {
  const totals = new Map<string, { accounts: number; amount: bigint; decimals: number | null }>();
  for (const entry of entries) {
    if (!entry.token) continue;
    const current = totals.get(entry.token.mint) ?? { accounts: 0, amount: 0n, decimals: entry.token.decimals };
    totals.set(entry.token.mint, {
      accounts: current.accounts + 1,
      amount: current.amount + BigInt(entry.token.amount),
      decimals: current.decimals,
    });
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mint, total]) => ({
      mint,
      accounts: total.accounts,
      amount: total.amount.toString(),
      uiAmount: total.decimals === null ? null : formatUnits(total.amount, total.decimals),
    }));
}

export async function buildAccountReport(
  reader: ChainReader,
  request: ReportRequest,
  context: { job: PublicKey; specHash: Uint8Array; programIds: SquareProgramIds },
): Promise<AccountReport> {
  const slot = await reader.getSlot('confirmed');
  const blockTime = await reader.getBlockTime(slot).catch(() => null);
  const infos = await reader.getMultipleAccountsInfo(request.accounts);
  const squareTypes = squareAccountTypes(context.programIds);
  const labels = ownerLabels(context.programIds);
  const decoded = request.accounts.map((address, index) => decode(address, infos[index] ?? null, squareTypes));
  const mints = await referencedMints(reader, decoded, request.accounts);
  const rent = await rentMinimums(
    reader,
    infos.map((info) => info?.data.length ?? 0),
  );
  const accounts: AccountEntry[] = [];
  for (const [index, address] of request.accounts.entries()) {
    const info = infos[index] ?? null;
    const item = decoded[index]!;
    const lamports = BigInt(info?.lamports ?? 0);
    const dataBytes = info?.data.length ?? 0;
    const minimum = rent.get(dataBytes) ?? 0n;
    const entry: AccountEntry = {
      address: address.toBase58(),
      kind: item.kind,
      lamports: lamports.toString(),
      sol: formatUnits(lamports, SOL_DECIMALS),
      owner: info?.owner.toBase58() ?? null,
      ownerLabel: info ? (labels.get(info.owner.toBase58()) ?? null) : null,
      executable: info?.executable ?? false,
      dataBytes,
      rentExemptMinimum: minimum.toString(),
      rentExempt: info !== null && lamports >= minimum,
      ...(item.token ? { token: holding(item.token, mints) } : {}),
      ...(item.mint ? { mint: mintSummary(item.mint) } : {}),
      ...(item.square ? { square: item.square } : {}),
    };
    if (request.signatures > 0) entry.activity = await activityOf(reader, address, request.signatures);
    accounts.push(entry);
  }
  const totalLamports = accounts.reduce((sum, entry) => sum + BigInt(entry.lamports), 0n);
  const kinds: Partial<Record<AccountKind, number>> = {};
  for (const entry of accounts) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  const missing = accounts.filter((entry) => entry.kind === 'missing').length;
  return {
    capability: ACCOUNT_REPORT_ID,
    job: context.job.toBase58(),
    specHash: hex(context.specHash),
    observedAt: { slot, blockTime: blockTime ? new Date(blockTime * 1000).toISOString() : null },
    accounts,
    summary: {
      accounts: accounts.length,
      existing: accounts.length - missing,
      missing,
      totalLamports: totalLamports.toString(),
      totalSol: formatUnits(totalLamports, SOL_DECIMALS),
      kinds,
      tokenTotals: tokenTotals(accounts),
    },
  };
}

export function accountReportCapability(price: bigint): AgentCapability {
  return {
    id: ACCOUNT_REPORT_ID,
    name: 'Solana hesap raporu',
    description:
      "Spec'te adı geçen hesapların zincirdeki durumunu (SOL, sahip program, token bakiyesi, mint arzı, Square hesap tipi, son işlemler) RPC'den okuyup JSON rapor olarak teslim eder.",
    tags: ['solana', 'onchain', 'report'],
    examples: ['{"capability":"solana.account-report","accounts":["<adres>"],"signatures":5}'],
    price,
  };
}

export function accountReportHandler(params: { reader: ChainReader; programIds: SquareProgramIds }): JobHandler {
  return async (request) => {
    const parsed = parseReportSpec(request.spec);
    await request.progress(`${parsed.accounts.length} hesap okunuyor`);
    const report = await buildAccountReport(params.reader, parsed, {
      job: request.job.address,
      specHash: specHashing.specHash(request.spec),
      programIds: params.programIds,
    });
    await request.progress(`rapor hazır: slot ${report.observedAt.slot}, ${report.summary.existing} hesap var`);
    return { content: `${JSON.stringify(report, null, 2)}\n`, contentType: 'application/json' };
  };
}
