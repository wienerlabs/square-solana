// İş detayı (FE-07, akışın 4. adımı): job hesabı, işlem loglarındaki escrow event'lerinden zaman çizelgesi,
// zincir saatine göre challenge sayacı ve agent'ın `accept_job` / `submit_work`'ü. Zaman çizelgesi job
// hesabına dokunan işlemlerden okunur; indexer gerekmez.
import { BorshCoder, EventParser, type Idl } from '@anchor-lang/core';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';
import { SQUARE_IDLS, workHash } from '@squaresdk/solana-sdk';

/** `Job.delivery_uri` üst sınırı (square_escrow `DELIVERY_URI_MAX_LEN`, `DeliveryUriTooLong`). */
export const MAX_DELIVERY_URI_BYTES = 128;

/** Zaman çizelgesinde okunan en fazla işlem. */
export const TIMELINE_LIMIT = 50;

/** Job adresinin en yeni imzasının yoklanma aralığı: WebSocket aboneliği kurulamaz ya da koparsa yedek yol. */
export const JOB_POLL_INTERVAL_MS = 5_000;

const coder = new BorshCoder(SQUARE_IDLS.escrow as unknown as Idl);

export interface JobEvent {
  name: string;
  data: Record<string, unknown>;
}

/** Bir işlemin loglarından bu job'a ait escrow event'leri (Anchor `emit!`). */
export function jobEventsFromLogs(escrowProgramId: PublicKey, logs: readonly string[], job: PublicKey): JobEvent[] {
  const parser = new EventParser(escrowProgramId, coder);
  const events: JobEvent[] = [];
  for (const { name, data } of parser.parseLogs([...logs])) {
    const fields = data as Record<string, unknown>;
    if (fields.job instanceof PublicKey && fields.job.equals(job)) events.push({ name, data: fields });
  }
  return events;
}

export interface TimelineEntry {
  signature: string;
  slot: number;
  /** Unix saniye; RPC vermiyorsa null. */
  blockTime: number | null;
  event: JobEvent;
}

export interface JobTimeline {
  entries: TimelineEntry[];
  /** Job adresine dokunan en yeni işlem (başarısızlar dahil); okunan durum bu imzaya kadardır. İşlem yoksa null. */
  newestSignature: string | null;
}

/** Job hesabına dokunan son işlemlerin event'leri, eskiden yeniye. */
export async function readJobTimeline(
  connection: Connection,
  escrowProgramId: PublicKey,
  job: PublicKey,
): Promise<JobTimeline> {
  const signatures = await connection.getSignaturesForAddress(job, { limit: TIMELINE_LIMIT }, 'confirmed');
  const newestSignature = signatures[0]?.signature ?? null;
  const ok = signatures.filter((s) => s.err === null).reverse();
  if (ok.length === 0) return { entries: [], newestSignature };
  const transactions = await connection.getTransactions(
    ok.map((s) => s.signature),
    { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  );
  const entries = ok.flatMap((s, i) =>
    jobEventsFromLogs(escrowProgramId, transactions[i]?.meta?.logMessages ?? [], job).map((event) => ({
      signature: s.signature,
      slot: s.slot,
      blockTime: s.blockTime ?? null,
      event,
    })),
  );
  return { entries, newestSignature };
}

/** Job adresine dokunan en yeni işlemin imzası; işlem yoksa null. */
export async function readNewestSignature(connection: Connection, job: PublicKey): Promise<string | null> {
  const [newest] = await connection.getSignaturesForAddress(job, { limit: 1 }, 'confirmed');
  return newest?.signature ?? null;
}

/**
 * Job adresinin en son görülen imzası. Log aboneliği, yoklama ve okunan zaman çizelgesi aynı imzayı
 * bildirir; `observe` yalnızca daha önce görülmemiş bir imzada true döner, böylece aynı değişiklik iki
 * kez okunmaz. Okunan durum bilinmeden (`known` false) yoklama karşılaştırma yapmaz.
 */
export class SignatureTracker {
  private seen: string | null | undefined;

  get known(): boolean {
    return this.seen !== undefined;
  }

  /** Okunan durumun dayandığı en yeni imza. */
  baseline(signature: string | null): void {
    this.seen = signature;
  }

  observe(signature: string | null): boolean {
    if (signature === this.seen) return false;
    this.seen = signature;
    return true;
  }
}

const str = (value: unknown) => (value instanceof PublicKey ? value.toBase58() : String(value));
const num = (value: unknown) => BigInt((value as { toString(): string }).toString());

/** Event'in okunur başlığı ve (varsa) ayrıntısı. Tutarlar settlement mint'in taban biriminde. */
export function describeJobEvent(
  event: JobEvent,
  formatAmount: (base: bigint) => string,
): { title: string; detail?: string } {
  const d = event.data;
  switch (event.name) {
    case 'JobCreated':
      return { title: 'Job opened', detail: `${formatAmount(num(d.amount))} for agent wallet ${str(d.agent_wallet)}` };
    case 'JobFunded':
      return { title: 'Funded', detail: `${formatAmount(num(d.amount))} locked in the vault` };
    case 'JobAccepted':
      return { title: 'Accepted by the agent' };
    case 'WorkSubmitted':
      return { title: 'Work delivered', detail: str(d.delivery_uri) };
    case 'ClaimListed':
      return { title: 'Receivable listed', detail: `for ${formatAmount(num(d.price))}` };
    case 'ClaimBought':
      return { title: 'Receivable sold', detail: `to ${str(d.buyer)} for ${formatAmount(num(d.price))}` };
    case 'ClaimCancelled':
      return { title: 'Receivable listing withdrawn' };
    case 'ReleaseVerified':
      return { title: 'Release proof verified', detail: `${formatAmount(num(d.net_amount))} to ${str(d.payee)}` };
    case 'ReleaseRefused':
      return { title: 'Release refused by the proof', detail: `${formatAmount(num(d.refunded_amount))} refunded` };
    case 'Finalized':
      return { title: 'Paid out', detail: `keeper fee ${formatAmount(num(d.keeper_fee))}` };
    case 'JobCancelled':
      return { title: 'Cancelled', detail: `${formatAmount(num(d.refunded_amount))} refunded` };
    case 'JobAgentWalletSynced':
      return { title: 'Agent wallet updated', detail: str(d.agent_wallet) };
    case 'TravelRuleCommitted':
      return { title: 'Travel Rule commitment bound' };
    case 'DisputeRaised':
      return { title: 'Dispute raised', detail: `bond ${formatAmount(num(d.bond))}` };
    case 'DisputeVote':
      return { title: 'Arbitrator vote' };
    case 'DisputeDecided':
      return { title: 'Dispute decided' };
    case 'DisputeResolved':
      return { title: 'Dispute resolved' };
    case 'DisputeLapsed':
      return { title: 'Dispute lapsed' };
    case 'MissingProofEscalated':
      return { title: 'Missing proof escalated' };
    case 'ValidationRecorded':
      return { title: 'Validation recorded' };
    case 'ReputationRecorded':
      return { title: 'Reputation recorded' };
    default:
      return { title: event.name };
  }
}

/** Clock sysvar'ının verisinden `unix_timestamp` (slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64). */
export function clockUnixTimestamp(data: Uint8Array): number {
  if (data.length < 40) throw new Error('Clock sysvar data is too short');
  return Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(32, true));
}

/** Zincirin saati (Clock sysvar'ı); programlar süreleri buna göre ölçer. */
export async function readChainTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info) throw new Error('Clock sysvar could not be read');
  return clockUnixTimestamp(info.data);
}

export type ChallengeState =
  { state: 'notStarted' } | { state: 'open'; remaining: number; endsAt: number } | { state: 'closed'; endsAt: number };

/**
 * Challenge penceresi, zincir saatine göre: teslimden sonra `challenge_end`'e kadar açık. Escrow
 * `now < challenge_end` iken finalize'ı reddeder (`ChallengePeriodNotExpired`); `challenge_end`'te kapanır.
 */
export function challengeState(challengeEnd: number, chainNow: number): ChallengeState {
  if (challengeEnd === 0) return { state: 'notStarted' };
  if (chainNow < challengeEnd) return { state: 'open', remaining: challengeEnd - chainNow, endsAt: challengeEnd };
  return { state: 'closed', endsAt: challengeEnd };
}

export function deliveryUriProblem(uri: string): string | null {
  if (uri.trim() === '') return 'Enter where the delivery can be fetched.';
  if (new TextEncoder().encode(uri).length > MAX_DELIVERY_URI_BYTES)
    return `The delivery URI is at most ${MAX_DELIVERY_URI_BYTES} bytes.`;
  return null;
}

/** Teslim edilen içeriğin taahhüdü: baytlarının SHA-256'sı (SDK `workHash`). */
export const deliveryHash = (content: Uint8Array) => workHash(content);
