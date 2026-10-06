// Zincirden okuma: job'lar, agent kayıtları, itibar, escrow config'i ve settlement mint'i. Süzgeçler RPC'nin
// `memcmp`'idir; alanların konumu IDL'den hesaplanır (sabit boyutlu alanların toplamı), kodda sayı tutulmaz. Okuma
// barındırılan bir API gerektirmez: sunucu yalnızca RPC ile çalışır.
import type { Idl, IdlField, IdlType } from '@anchor-lang/core';
import { getMint } from '@solana/spl-token';
import { PublicKey, type Connection, type GetProgramAccountsFilter } from '@solana/web3.js';
import { SQUARE_IDLS, toIdlJson, type IdlJson, type SquareClient } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';

/** Sabit boyutlu IDL tiplerinin bayt boyutu; değişken boyutlu tipte (string, vec, option) null. */
function fixedSize(idl: Idl, type: IdlType): number | null {
  if (typeof type === 'string') {
    const sizes: Record<string, number> = {
      bool: 1,
      u8: 1,
      i8: 1,
      u16: 2,
      i16: 2,
      u32: 4,
      i32: 4,
      u64: 8,
      i64: 8,
      u128: 16,
      i128: 16,
      pubkey: 32,
    };
    return sizes[type] ?? null;
  }
  if ('array' in type) {
    const [inner, length] = type.array;
    const size = fixedSize(idl, inner);
    return size === null || typeof length !== 'number' ? null : size * length;
  }
  if ('defined' in type) {
    const def = idl.types?.find((candidate) => candidate.name === type.defined.name);
    if (def?.type.kind === 'enum' && def.type.variants.every((variant) => !variant.fields?.length)) return 1;
    if (def?.type.kind === 'struct') {
      let total = 0;
      for (const field of (def.type.fields ?? []) as IdlField[]) {
        const size = fixedSize(idl, field.type);
        if (size === null) return null;
        total += size;
      }
      return total;
    }
  }
  return null;
}

/** Hesaptaki alanın konumu: discriminator (8) ve önceki alanların boyutu. */
export function fieldOffset(idl: Idl, account: string, field: string): number {
  const def = idl.types?.find((candidate) => candidate.name === account);
  if (def?.type.kind !== 'struct') throw new Error(`${account} IDL'de yapı değil`);
  let offset = 8;
  for (const entry of (def.type.fields ?? []) as IdlField[]) {
    if (entry.name === field) return offset;
    const size = fixedSize(idl, entry.type);
    if (size === null) throw new Error(`${account}.${field}: önündeki ${entry.name} değişken boyutlu`);
    offset += size;
  }
  throw new Error(`${account} hesabında ${field} alanı yok`);
}

/** Alt alanları olmayan enum'un varyant sırası (borsh'ta tek bayt). */
export function variantIndex(idl: Idl, enumName: string, variant: string): number {
  const def = idl.types?.find((candidate) => candidate.name === enumName);
  if (def?.type.kind !== 'enum') throw new Error(`${enumName} IDL'de enum değil`);
  const index = def.type.variants.findIndex((entry) => entry.name.toLowerCase() === variant.toLowerCase());
  if (index < 0) throw new Error(`${enumName} enum'unda ${variant} yok`);
  return index;
}

const ESCROW = SQUARE_IDLS.escrow as unknown as Idl;
const REGISTRY = SQUARE_IDLS.registry as unknown as Idl;
const discriminator = (idl: Idl, account: string): GetProgramAccountsFilter => {
  const entry = idl.accounts?.find((candidate) => candidate.name === account);
  if (!entry) throw new Error(`IDL'de ${account} hesabı yok`);
  return { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(entry.discriminator)) } };
};
const memcmp = (offset: number, bytes: Uint8Array): GetProgramAccountsFilter => ({
  memcmp: { offset, bytes: bs58.encode(bytes) },
});

export const JOB_STATUSES = [
  'open',
  'funded',
  'accepted',
  'delivered',
  'disputed',
  'resolved',
  'released',
  'refunded',
  'cancelled',
] as const;
export type JobStatusName = (typeof JOB_STATUSES)[number];

/** Kasada tutarı kilitli işler (program arayüzü §6). */
export const ESCROWED: readonly JobStatusName[] = ['funded', 'accepted', 'delivered', 'disputed', 'resolved'];

export const JOB_OFFSETS = {
  institution: fieldOffset(ESCROW, 'Job', 'institution'),
  agentRecord: fieldOffset(ESCROW, 'Job', 'agent_record'),
  mint: fieldOffset(ESCROW, 'Job', 'mint'),
  amount: fieldOffset(ESCROW, 'Job', 'amount'),
  status: fieldOffset(ESCROW, 'Job', 'status'),
};
export const AGENT_OFFSETS = {
  owner: fieldOffset(REGISTRY, 'AgentRecord', 'owner'),
  status: fieldOffset(REGISTRY, 'AgentRecord', 'status'),
};

export interface Located<T> {
  readonly address: PublicKey;
  readonly account: T;
}

export interface JobFilter {
  readonly status?: JobStatusName;
  readonly agentRecord?: PublicKey;
  readonly institution?: PublicKey;
}

type JobAccount = NonNullable<Awaited<ReturnType<SquareClient['escrow']['fetch']>>> & Record<string, unknown>;

export interface ChainReader {
  jobs(filter: JobFilter): Promise<Located<Record<string, unknown>>[]>;
  job(address: PublicKey): Promise<Record<string, unknown> | null>;
  /** Bütün job'ların yalnızca mint, tutar ve durum alanları (istatistik; hesap verisinin küçük bir dilimi). */
  jobSummaries(): Promise<{ mint: PublicKey; amount: bigint; status: JobStatusName }[]>;
  agents(filter: {
    owner?: PublicKey;
    status?: 'active' | 'inactive' | 'deregistered';
  }): Promise<Located<Record<string, unknown>>[]>;
  agent(address: PublicKey): Promise<Record<string, unknown> | null>;
  reputations(agentRecords: readonly PublicKey[]): Promise<(Record<string, unknown> | null)[]>;
  claim(job: PublicKey): Promise<Record<string, unknown> | null>;
  settlement(): Promise<{ mint: PublicKey; decimals: number; challengePeriod: { min: bigint; max: bigint } }>;
  /** Anchor değerini sözleşmenin JSON kodlamasına çevirir (adresler base58, u64 ondalık dize, enum adı). */
  json(program: 'escrow' | 'registry', type: string, value: unknown): IdlJson;
}

export function createChainReader(deps: { client: SquareClient; connection: Connection }): ChainReader {
  const { client, connection } = deps;
  const escrow = client.escrow.program;
  const registry = client.registry.program;
  let settlement: ReturnType<ChainReader['settlement']> | null = null;

  return {
    async jobs(filter) {
      const filters: GetProgramAccountsFilter[] = [];
      if (filter.status) {
        filters.push(memcmp(JOB_OFFSETS.status, Uint8Array.of(variantIndex(ESCROW, 'JobStatus', filter.status))));
      }
      if (filter.agentRecord) filters.push(memcmp(JOB_OFFSETS.agentRecord, filter.agentRecord.toBytes()));
      if (filter.institution) filters.push(memcmp(JOB_OFFSETS.institution, filter.institution.toBytes()));
      const rows = await escrow.account.job.all(filters);
      return rows.map((row) => ({ address: row.publicKey, account: row.account as unknown as JobAccount }));
    },

    async job(address) {
      return (await client.escrow.fetch('job', address)) as JobAccount | null;
    },

    async jobSummaries() {
      const length = JOB_OFFSETS.status + 1 - JOB_OFFSETS.mint;
      const accounts = await connection.getProgramAccounts(client.programIds.escrow, {
        commitment: 'confirmed',
        filters: [discriminator(ESCROW, 'Job')],
        dataSlice: { offset: JOB_OFFSETS.mint, length },
      });
      return accounts.map(({ account }) => {
        const data = account.data;
        const at = (offset: number) => offset - JOB_OFFSETS.mint;
        return {
          mint: new PublicKey(data.subarray(at(JOB_OFFSETS.mint), at(JOB_OFFSETS.mint) + 32)),
          amount: data.readBigUInt64LE(at(JOB_OFFSETS.amount)),
          status: JOB_STATUSES[data[at(JOB_OFFSETS.status)]!]!,
        };
      });
    },

    async agents(filter) {
      const filters: GetProgramAccountsFilter[] = [];
      if (filter.owner) filters.push(memcmp(AGENT_OFFSETS.owner, filter.owner.toBytes()));
      if (filter.status) {
        filters.push(memcmp(AGENT_OFFSETS.status, Uint8Array.of(variantIndex(REGISTRY, 'AgentStatus', filter.status))));
      }
      const rows = await registry.account.agentRecord.all(filters);
      return rows.map((row) => ({
        address: row.publicKey,
        account: row.account as unknown as Record<string, unknown>,
      }));
    },

    async agent(address) {
      return (await client.registry.fetch('agentRecord', address)) as Record<string, unknown> | null;
    },

    async reputations(agentRecords) {
      if (agentRecords.length === 0) return [];
      const addresses = agentRecords.map((record) => client.pda.agentReputation(record)[0]);
      return (await escrow.account.agentReputation.fetchMultiple(addresses)) as (Record<string, unknown> | null)[];
    },

    async claim(job) {
      return (await client.escrow.fetch('claimListing', client.pda.claimListing(job)[0])) as Record<
        string,
        unknown
      > | null;
    },

    settlement() {
      settlement ??= (async () => {
        const config = await client.escrow.fetch('escrowConfig', client.pda.escrowConfig()[0]);
        if (!config) throw new Error('escrow config hesabı yok: escrow bu ağda init edilmemiş');
        const info = await connection.getAccountInfo(config.settlementMint, 'confirmed');
        if (!info) throw new Error(`settlement mint hesabı yok: ${config.settlementMint.toBase58()}`);
        const mint = await getMint(connection, config.settlementMint, 'confirmed', info.owner);
        return {
          mint: config.settlementMint,
          decimals: mint.decimals,
          challengePeriod: {
            min: BigInt(config.params.minChallengePeriod.toString()),
            max: BigInt(config.params.maxChallengePeriod.toString()),
          },
        };
      })().catch((error: unknown) => {
        settlement = null;
        throw error;
      });
      return settlement;
    },

    json(program, type, value) {
      const idl = (program === 'escrow' ? escrow.idl : registry.idl) as unknown as Idl;
      return toIdlJson(idl, { defined: { name: type } }, value);
    },
  };
}
