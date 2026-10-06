// Arbitrator konsolu (FE-17): kuyruk API'den (`GET /v1/arbitration/queue`), oy kısıtları zincirdeki job'dan ve
// config'ten (`dispute.ts`), oy tx'i API'den (`POST /v1/disputes/{job}/votes`). API'nin hazırladığı tx
// imzalanmadan önce burada çözülür: yalnızca bu job'a, bu arbitrator'ın imzasıyla, seçilen kararla bir
// `resolve_dispute` (ve compute budget talimatları) taşıyorsa cüzdana gider.
import { BorshInstructionCoder, type Idl } from '@anchor-lang/core';
import {
  ComputeBudgetProgram,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type PublicKey,
} from '@solana/web3.js';
import { SQUARE_IDLS } from '@squaresdk/solana-sdk';
import type { ArbitrationEventType, DisputeVoteRequest } from '@squaresdk/solana-types';
import { resolutionOf, sameResolution, type DisputeResolution } from './dispute';
import { parseUnits, type ParsedUnits } from './settlement';

const instructionCoder = new BorshInstructionCoder(SQUARE_IDLS.escrow as unknown as Idl);

/** Oy isteği: fee payer arbitrator'ın kendisi, priority fee sunucu profili. */
export const voteRequest = (resolution: DisputeResolution): DisputeVoteRequest => ({
  resolution,
  feePayer: null,
  computeUnitPrice: null,
});

/** API'nin base64 v0 tx'i. */
export const decodeUnsignedTransaction = (base64: string) =>
  VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(base64, 'base64')));

/** Tx'in kullandığı address lookup table'lar, zincirden. */
export async function readLookupTables(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const keys = transaction.message.addressTableLookups.map((lookup) => lookup.accountKey);
  const tables = await Promise.all(keys.map((key) => connection.getAddressLookupTable(key)));
  return tables.map(({ value }, i) => {
    if (!value) throw new Error(`Address lookup table ${keys[i]!.toBase58()} was not found.`);
    return value;
  });
}

/**
 * Tx imzalanmaya uygun mu: fee payer arbitrator, imzacı yalnızca o, talimatlar compute budget ve tek bir escrow
 * `resolve_dispute`; hesapları `[arbitrator, config, job]`, kararı istenenle aynı. Uygunsa null, değilse sebebi.
 */
export function voteTransactionProblem(
  transaction: VersionedTransaction,
  expected: {
    escrowProgramId: PublicKey;
    config: PublicKey;
    arbitrator: PublicKey;
    job: PublicKey;
    resolution: DisputeResolution;
  },
  lookupTables: AddressLookupTableAccount[] = [],
): string | null {
  const message = transaction.message;
  const keys = message.getAccountKeys({ addressLookupTableAccounts: lookupTables });
  if (!keys.get(0)?.equals(expected.arbitrator)) return 'The fee payer is not your wallet.';
  if (message.header.numRequiredSignatures !== 1) return 'The transaction asks for more than your signature.';
  const votes = [];
  for (const ix of message.compiledInstructions) {
    const program = keys.get(ix.programIdIndex);
    if (program?.equals(ComputeBudgetProgram.programId)) continue;
    if (!program?.equals(expected.escrowProgramId)) return 'The transaction calls a program other than the escrow.';
    votes.push(ix);
  }
  if (votes.length !== 1) return 'The transaction does not carry exactly one escrow instruction.';
  const [vote] = votes;
  const decoded = instructionCoder.decode(Buffer.from(vote!.data));
  if (decoded?.name !== 'resolve_dispute') return 'The escrow instruction is not resolve_dispute.';
  const accounts = vote!.accountKeyIndexes.map((index) => keys.get(index));
  const wanted = [expected.arbitrator, expected.config, expected.job];
  if (accounts.length !== wanted.length || accounts.some((key, i) => !key?.equals(wanted[i]!)))
    return 'The vote is for another job or arbitrator.';
  let resolution: DisputeResolution;
  try {
    resolution = resolutionOf((decoded.data as { resolution: unknown }).resolution);
  } catch {
    return 'The vote carries an unknown decision.';
  }
  if (!sameResolution(resolution, expected.resolution)) return 'The vote carries another decision than you chose.';
  return null;
}

/** Split'te agent'ın payı: USDC olarak, en fazla escrow'daki tutar (`InvalidSplitAmount`). */
export function parseSplitAmount(text: string, decimals: number, amount: bigint): ParsedUnits {
  const parsed = parseUnits(text.trim(), decimals);
  if (!parsed.ok) return parsed;
  if (parsed.value > amount) return { ok: false, error: 'The agent’s share cannot exceed the escrowed amount.' };
  return parsed;
}

/** Webhook olaylarının açıklaması (apps/api "Bildirim"). */
export const ARBITRATION_EVENTS: Readonly<Record<ArbitrationEventType, string>> = {
  'dispute.raised': 'An institution raised a dispute',
  'dispute.escalated': 'An agent escalated a missing proof',
  'dispute.vote': 'Another arbitrator voted',
  'dispute.decided': 'The dispute reached the threshold',
  'dispute.deadline': 'The deadline is near and you have not voted',
};

/**
 * Webhook ucu: https, en fazla 512 karakter. http yalnızca localnet'te kabul edilir (API'nin
 * `API_NOTIFY_ALLOW_INSECURE`'u); son söz API'nindir.
 */
export function webhookUrlProblem(value: string, allowHttp = false): string | null {
  if (value.trim() === '') return 'Enter the endpoint’s URL.';
  if (value.length > 512) return 'The URL is at most 512 characters.';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return 'Webhook endpoints use https.';
  } catch {
    return 'This is not a valid URL.';
  }
  return null;
}

/** İndirilecek kanıt dosyasının adı: job ve içeriğin hash'inin başı. */
export const evidenceFileName = (job: string, reasonHash: string) =>
  `square-evidence-${job.slice(0, 8)}-${reasonHash.slice(0, 16)}`;
