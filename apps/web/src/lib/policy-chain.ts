// Politikanın zincir tarafı (FE-04, adım 1 ve 5): square_policy'nin `init_institution`, `set_policy`,
// `update_policy` ve `set_buyer_root` talimatları (program arayüzü §10.2, BC-17, BC-18). Zincire yalnızca
// commitment, public günlük tavan ve alıcı kökü gider; politikanın kendisi ve salt'lar tarayıcıda kalır.
// Geçmiş, politika hesabına dokunan işlemlerin loglarındaki event'lerden okunur (indexer gerekmez).
import { BorshCoder, EventParser, Program, type Idl } from '@anchor-lang/core';
import BN from 'bn.js';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { SQUARE_IDLS, type SquarePolicyContract } from '@squaresdk/solana-sdk';
import { institutionAddress, policyAddress } from './idl-pda';
import { programErrorMessage } from './program-error';
import { readTransactionLogs } from './transaction-logs';

/** `Institution.name` üst sınırı (square_policy `NameTooLong`). */
export const MAX_INSTITUTION_NAME_BYTES = 64;

/** Geçmişte okunan en fazla işlem. */
export const HISTORY_LIMIT = 20;

export interface InstitutionView {
  ownerKey: PublicKey;
  name: string;
  policyCount: number;
  /** Bağlı Squads vault'u; varsa yetkili yalnızca odur. */
  multisigVault: PublicKey | null;
}

export interface PolicyView {
  commitment: Uint8Array;
  dailyCeiling: bigint;
  buyerRoot: Uint8Array;
  version: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyChainState {
  institution: InstitutionView | null;
  policy: PolicyView | null;
}

const policyProgram = (connection: Connection, programId: PublicKey) =>
  new Program<SquarePolicyContract>({ ...SQUARE_IDLS.policy, address: programId.toBase58() }, { connection });

const bytes = (value: number[]) => Uint8Array.from(value);

/** Kurum ve politika hesapları; açılmamışsa null. */
export async function readPolicyChain(
  connection: Connection,
  programId: PublicKey,
  owner: PublicKey,
  policyId: Uint8Array,
): Promise<PolicyChainState> {
  const program = policyProgram(connection, programId);
  const institution = institutionAddress(programId, owner);
  const [inst, policy] = await Promise.all([
    program.account.institution.fetchNullable(institution),
    program.account.policy.fetchNullable(policyAddress(programId, institution, policyId)),
  ]);
  return {
    institution: inst && {
      ownerKey: inst.ownerKey,
      name: inst.name,
      policyCount: inst.policyCount,
      multisigVault: inst.multisigVault,
    },
    policy: policy && {
      commitment: bytes(policy.commitment),
      dailyCeiling: BigInt(policy.dailyCeiling.toString()),
      buyerRoot: bytes(policy.buyerRoot),
      version: policy.version,
      active: policy.active,
      createdAt: policy.createdAt.toNumber(),
      updatedAt: policy.updatedAt.toNumber(),
    },
  };
}

export interface CommitTarget {
  commitment: Uint8Array;
  dailyCeiling: bigint;
  buyerRoot: Uint8Array;
  /** Yalnızca kurum hesabı yoksa kullanılır. */
  institutionName: string;
}

export type CommitStep = 'initInstitution' | 'setPolicy' | 'updatePolicy' | 'setBuyerRoot';

export type CommitPlan =
  { state: 'ready'; steps: CommitStep[] } | { state: 'unchanged' } | { state: 'blocked'; reason: string };

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const isZero = (value: Uint8Array) => value.every((byte) => byte === 0);

export function institutionNameProblem(name: string): string | null {
  if (name.trim() === '') return 'Name the institution.';
  if (new TextEncoder().encode(name).length > MAX_INSTITUTION_NAME_BYTES)
    return `The name is at most ${MAX_INSTITUTION_NAME_BYTES} bytes.`;
  return null;
}

/**
 * Zinciri taslağa getiren talimatlar, tek işlemde ve bu sırayla: kurum yoksa `init_institution`; politika
 * yoksa `set_policy` (kök sıfırla açılır), varsa commitment ya da tavan değiştiyse `update_policy`; kök
 * zincirdekinden farklıysa `set_buyer_root`.
 */
export function planPolicyCommit(chain: PolicyChainState, target: CommitTarget): CommitPlan {
  if (chain.institution?.multisigVault) {
    return {
      state: 'blocked',
      reason: `This institution is controlled by its Squads multisig (vault ${chain.institution.multisigVault.toBase58()}). Commit through Squads.`,
    };
  }
  if (target.dailyCeiling <= 0n)
    return { state: 'blocked', reason: 'The public daily ceiling must be greater than zero.' };
  const steps: CommitStep[] = [];
  if (!chain.institution) {
    const problem = institutionNameProblem(target.institutionName);
    if (problem) return { state: 'blocked', reason: problem };
    steps.push('initInstitution');
  }
  const onChainRoot = chain.policy?.buyerRoot ?? new Uint8Array(32);
  if (!chain.policy) {
    steps.push('setPolicy');
  } else if (!chain.policy.active) {
    return { state: 'blocked', reason: 'This policy is deactivated on chain. Start a new policy instead.' };
  } else if (!equal(chain.policy.commitment, target.commitment) || chain.policy.dailyCeiling !== target.dailyCeiling) {
    steps.push('updatePolicy');
  }
  if (!equal(onChainRoot, target.buyerRoot) && !(steps.includes('setPolicy') && isZero(target.buyerRoot))) {
    steps.push('setBuyerRoot');
  }
  return steps.length === 0 ? { state: 'unchanged' } : { state: 'ready', steps };
}

export const COMMIT_STEP_LABEL: Readonly<Record<CommitStep, string>> = {
  initInstitution: 'init_institution: open the institution account',
  setPolicy: 'set_policy: commit the policy (version 1)',
  updatePolicy: 'update_policy: replace the commitment or ceiling (next version)',
  setBuyerRoot: 'set_buyer_root: publish the approved-buyer root',
};

/**
 * Planın talimatları; `owner` yetkili (cüzdan ya da smart account'un vault'u), `payer` rent'i ödeyen (verilmezse
 * `owner`; sponsorlu gönderimde sponsor, FE-21). Ağa gitmez.
 */
export async function policyCommitInstructions(
  connection: Connection,
  input: {
    programId: PublicKey;
    owner: PublicKey;
    payer?: PublicKey;
    policyId: Uint8Array;
    steps: readonly CommitStep[];
    target: CommitTarget;
  },
): Promise<TransactionInstruction[]> {
  const program = policyProgram(connection, input.programId);
  const institution = institutionAddress(input.programId, input.owner);
  const policy = policyAddress(input.programId, institution, input.policyId);
  const { owner, target } = input;
  const payer = input.payer ?? owner;
  const build = (step: CommitStep): Promise<TransactionInstruction> => {
    switch (step) {
      case 'initInstitution':
        return program.methods
          .initInstitution(target.institutionName)
          .accountsStrict({ payer, authority: owner, institution, systemProgram: SystemProgram.programId })
          .instruction();
      case 'setPolicy':
        return program.methods
          .setPolicy(Array.from(input.policyId), Array.from(target.commitment), new BN(target.dailyCeiling.toString()))
          .accountsStrict({
            payer,
            authority: owner,
            institution,
            policy,
            systemProgram: SystemProgram.programId,
          })
          .instruction();
      case 'updatePolicy':
        return program.methods
          .updatePolicy(Array.from(target.commitment), new BN(target.dailyCeiling.toString()))
          .accountsStrict({ authority: owner, institution, policy })
          .instruction();
      case 'setBuyerRoot':
        return program.methods
          .setBuyerRoot(Array.from(target.buyerRoot))
          .accountsStrict({ authority: owner, institution, policy })
          .instruction();
    }
  };
  return Promise.all(input.steps.map(build));
}

/** İmzasız v0 tx; ücret ödeyicisi `payer` (verilmezse `owner`), blockhash bağlantıdan. */
export async function buildPolicyCommitTx(
  connection: Connection,
  input: Parameters<typeof policyCommitInstructions>[1],
): Promise<VersionedTransaction> {
  const [instructions, { blockhash }] = await Promise.all([
    policyCommitInstructions(connection, input),
    connection.getLatestBlockhash('confirmed'),
  ]);
  const message = new TransactionMessage({
    payerKey: input.payer ?? input.owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** square_policy hata kodunun IDL'deki açıklaması; policy hatası değilse null. */
export const policyErrorMessage = (error: unknown): string | null => programErrorMessage(SQUARE_IDLS.policy, error);

export type PolicyHistoryEvent =
  | { kind: 'committed'; version: number; commitment: Uint8Array; dailyCeiling: bigint }
  | { kind: 'updated'; version: number; commitment: Uint8Array; dailyCeiling: bigint }
  | { kind: 'buyerRoot'; buyerRoot: Uint8Array }
  | { kind: 'deactivated' };

export interface PolicyHistoryEntry {
  signature: string;
  slot: number;
  /** Unix saniye; RPC vermiyorsa null. */
  blockTime: number | null;
  event: PolicyHistoryEvent;
}

const coder = new BorshCoder(SQUARE_IDLS.policy as unknown as Idl);

type EventData = Record<string, unknown>;
const field = (data: EventData, snake: string, camel: string) => data[snake] ?? data[camel];
const toBytes = (value: unknown) => Uint8Array.from(value as number[]);
const toBigInt = (value: unknown) => BigInt((value as { toString(): string }).toString());

/** Bir işlemin loglarından bu politikaya ait event'ler (Anchor `emit!`, `Program data:` satırları). */
export function policyEventsFromLogs(
  programId: PublicKey,
  logs: readonly string[],
  policy: PublicKey,
): PolicyHistoryEvent[] {
  const parser = new EventParser(programId, coder);
  const events: PolicyHistoryEvent[] = [];
  for (const { name, data } of parser.parseLogs([...logs])) {
    const d = data as EventData;
    if (!(d.policy instanceof PublicKey) || !d.policy.equals(policy)) continue;
    if (name === 'PolicyCommitted' || name === 'PolicyUpdated') {
      events.push({
        kind: name === 'PolicyCommitted' ? 'committed' : 'updated',
        version: Number(d.version),
        commitment: toBytes(d.commitment),
        dailyCeiling: toBigInt(field(d, 'daily_ceiling', 'dailyCeiling')),
      });
    } else if (name === 'BuyerRootCommitted') {
      events.push({ kind: 'buyerRoot', buyerRoot: toBytes(field(d, 'buyer_root', 'buyerRoot')) });
    } else if (name === 'PolicyDeactivated') {
      events.push({ kind: 'deactivated' });
    }
  }
  return events;
}

/** Politika hesabına dokunan son işlemlerin event'leri, yeniden eskiye. */
export async function readPolicyHistory(
  connection: Connection,
  programId: PublicKey,
  policy: PublicKey,
): Promise<PolicyHistoryEntry[]> {
  const signatures = await connection.getSignaturesForAddress(policy, { limit: HISTORY_LIMIT }, 'confirmed');
  const ok = signatures.filter((s) => s.err === null);
  if (ok.length === 0) return [];
  const logs = await readTransactionLogs(
    connection,
    ok.map((s) => s.signature),
  );
  return ok.flatMap((s) =>
    policyEventsFromLogs(programId, logs.get(s.signature) ?? [], policy).map((event) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      event,
    })),
  );
}
