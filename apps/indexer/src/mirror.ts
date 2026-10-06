// Hesabın IDL JSON'undan ayna tablo satırı (veri modeli §2). `account` sütunu JSON'un kendisidir; diğer
// sütunlar filtre ve sıralama içindir ve yalnızca ondan çıkarılır. `disputes`, `Job.dispute`'un izdüşümüdür:
// dispute açılmamış job'da (`raisedAt == 0`) satır yoktur.
import type { IdlJson } from '@squaresdk/solana-sdk';
import type { MirroredAccount } from './codec.js';

/** Prisma model adları (istemcinin alanları). */
export type MirrorTable =
  | 'institution'
  | 'policy'
  | 'agent'
  | 'screening'
  | 'job'
  | 'claim'
  | 'agentReputation'
  | 'validationRecord'
  | 'releaseProof';

type Json = Readonly<Record<string, IdlJson>>;
export type MirrorColumns = Record<string, unknown>;

export interface TableSpec {
  readonly table: MirrorTable;
  /** Hesap kapanabilir: satır silinmez, `closedSlot` yazılır (veri modeli §2). */
  readonly closable: boolean;
  columns(json: Json): MirrorColumns;
}

/** Atanmamış adres alanı (ör. satılmamış alacağın alıcısı): `Pubkey::default`. */
const DEFAULT_ADDRESS = '11111111111111111111111111111111';

const str = (json: Json, key: string): string => {
  const value = json[key];
  if (typeof value !== 'string') throw new Error(`ayna: ${key} dize değil`);
  return value;
};
const big = (json: Json, key: string): bigint => {
  const value = json[key];
  if (typeof value !== 'number') throw new Error(`ayna: ${key} tamsayı değil`);
  return BigInt(value);
};
const num = (json: Json, key: string): number => {
  const value = json[key];
  if (typeof value !== 'number') throw new Error(`ayna: ${key} sayı değil`);
  return value;
};
const bool = (json: Json, key: string): boolean => {
  const value = json[key];
  if (typeof value !== 'boolean') throw new Error(`ayna: ${key} boolean değil`);
  return value;
};
const nullableStr = (json: Json, key: string): string | null => (json[key] === null ? null : str(json, key));
const object = (json: Json, key: string): Json => {
  const value = json[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`ayna: ${key} nesne değil`);
  return value;
};

export const TABLES: Readonly<Record<MirroredAccount, TableSpec>> = {
  Institution: {
    table: 'institution',
    closable: false,
    columns: (j) => ({
      ownerKey: str(j, 'ownerKey'),
      multisigVault: nullableStr(j, 'multisigVault'),
      name: str(j, 'name'),
    }),
  },
  Policy: {
    table: 'policy',
    closable: false,
    columns: (j) => ({
      institution: str(j, 'institution'),
      policyId: str(j, 'policyId'),
      version: num(j, 'version'),
      active: bool(j, 'active'),
    }),
  },
  AgentRecord: {
    table: 'agent',
    closable: false,
    columns: (j) => ({
      creator: str(j, 'creator'),
      owner: str(j, 'owner'),
      wallet: str(j, 'wallet'),
      agentId: str(j, 'agentId'),
      status: str(j, 'status'),
      agentCardUri: str(j, 'agentCardUri'),
      agentCardHash: str(j, 'agentCardHash'),
    }),
  },
  ScreeningRecord: {
    table: 'screening',
    closable: false,
    columns: (j) => ({
      wallet: str(j, 'wallet'),
      status: str(j, 'status'),
      screenedAt: big(j, 'screenedAt'),
      expiresAt: big(j, 'expiresAt'),
      sourceHash: str(j, 'sourceHash'),
    }),
  },
  Job: {
    table: 'job',
    closable: true,
    columns: (j) => ({
      institution: str(j, 'institution'),
      agentRecord: str(j, 'agentRecord'),
      agentWallet: str(j, 'agentWallet'),
      policy: nullableStr(j, 'policy'),
      mint: str(j, 'mint'),
      amount: str(j, 'amount'),
      specHash: str(j, 'specHash'),
      status: str(j, 'status'),
      createdAt: big(j, 'createdAt'),
      deadline: big(j, 'deadline'),
      challengeEnd: big(j, 'challengeEnd'),
    }),
  },
  ClaimListing: {
    table: 'claim',
    closable: true,
    columns: (j) => {
      const buyer = str(j, 'buyer');
      return {
        job: str(j, 'job'),
        seller: str(j, 'seller'),
        buyer: buyer === DEFAULT_ADDRESS ? null : buyer,
        status: str(j, 'status'),
        price: str(j, 'price'),
        faceValue: str(j, 'faceValue'),
      };
    },
  },
  AgentReputation: {
    table: 'agentReputation',
    closable: false,
    columns: (j) => ({
      agentRecord: str(j, 'agentRecord'),
      jobsCompleted: str(j, 'jobsCompleted'),
      totalEarned: str(j, 'totalEarned'),
    }),
  },
  ValidationRecord: {
    table: 'validationRecord',
    closable: false,
    columns: (j) => ({ job: str(j, 'job'), agentRecord: str(j, 'agentRecord'), outcome: str(j, 'outcome') }),
  },
  ReleaseProof: {
    table: 'releaseProof',
    closable: false,
    columns: (j) => ({
      job: str(j, 'job'),
      institution: str(j, 'institution'),
      policy: str(j, 'policy'),
      payee: str(j, 'payee'),
      verdict: str(j, 'verdict'),
      refusalCode: num(j, 'refusalCode'),
      consumed: bool(j, 'consumed'),
      netAmount: str(j, 'netAmount'),
      proofTimestamp: big(j, 'proofTimestamp'),
    }),
  },
};

/** Job'un dispute izdüşümü; dispute açılmamışsa null. */
export function disputeColumns(job: Json): MirrorColumns | null {
  const dispute = object(job, 'dispute');
  if (num(dispute, 'raisedAt') === 0) return null;
  const resolution = object(dispute, 'resolution');
  return {
    institution: str(job, 'institution'),
    agentRecord: str(job, 'agentRecord'),
    jobStatus: str(job, 'status'),
    challenger: str(dispute, 'challenger'),
    bond: str(dispute, 'bond'),
    reasonHash: str(dispute, 'reasonHash'),
    raisedAt: big(dispute, 'raisedAt'),
    deadline: big(dispute, 'deadline'),
    resolution: str(resolution, 'kind'),
    lapsed: bool(dispute, 'lapsed'),
  };
}
