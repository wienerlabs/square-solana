// İş detayı (FE-07, akışın 4. adımı): job hesabı, işlem loglarındaki escrow event'lerinden zaman çizelgesi,
// zincir saatine göre challenge sayacı ve agent'ın `accept_job` / `submit_work`'ü. Zaman çizelgesi job
// hesabına dokunan işlemlerden okunur; indexer gerekmez. Teslim dosyası Square API'ye yüklenebilir
// (`uploadDelivery`): depo içeriği SHA-256'sıyla adresler, adresi teslim URI'si olur.
import { BorshCoder, EventParser, type Idl } from '@anchor-lang/core';
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';
import { SQUARE_IDLS, workHash } from '@squaresdk/solana-sdk';
import type { DeliveryReceipt } from '@squaresdk/solana-types';
import { hex } from './agent-registration';
import { formatDiscount } from './claim-market';
import { describeResolution, resolutionOf } from './dispute';
import { refusalReasons } from './release-proof';
import { SquareApiError } from './square-api';

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
  /**
   * İzlenen her adrese dokunan en yeni işlem (başarısızlar dahil), adrese göre; okunan durum bu imzalara
   * kadardır. İşlem yoksa null.
   */
  newest: ReadonlyMap<string, string | null>;
}

/**
 * Job'un zaman çizelgesi, eskiden yeniye: job hesabına ve alacak listelemesine dokunan son işlemlerin
 * event'leri. Listelemenin geri çekilmesi (`cancel_claim`) job hesabına dokunmaz, yalnızca listelemeye.
 */
export async function readJobTimeline(
  connection: Connection,
  escrowProgramId: PublicKey,
  job: PublicKey,
  claimListing: PublicKey,
): Promise<JobTimeline> {
  const watched = [job, claimListing];
  const lists = await Promise.all(
    watched.map((address) => connection.getSignaturesForAddress(address, { limit: TIMELINE_LIMIT }, 'confirmed')),
  );
  const newest = new Map(watched.map((address, i) => [address.toBase58(), lists[i]![0]?.signature ?? null]));
  // İki listede de geçen işlem bir kez sayılır; listeler yeniden eskiye, sıralama aynı slot içinde bunu korur.
  const unique = new Map(lists.flat().map((s) => [s.signature, s]));
  const ok = [...unique.values()]
    .filter((s) => s.err === null)
    .sort((a, b) => b.slot - a.slot)
    .slice(0, TIMELINE_LIMIT)
    .reverse();
  if (ok.length === 0) return { entries: [], newest };
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
  return { entries, newest };
}

/** Adrese dokunan en yeni işlemin imzası; işlem yoksa null. */
export async function readNewestSignature(connection: Connection, address: PublicKey): Promise<string | null> {
  const [newest] = await connection.getSignaturesForAddress(address, { limit: 1 }, 'confirmed');
  return newest?.signature ?? null;
}

/**
 * İzlenen adreslerin (job ve alacak listelemesi) en son görülen imzaları. Log aboneliği, yoklama ve okunan
 * zaman çizelgesi aynı imzayı bildirir; `observe` yalnızca o adreste daha önce görülmemiş bir imzada true
 * döner, böylece aynı değişiklik iki kez okunmaz. Okunan durum bilinmeden (`known` false) yoklama
 * karşılaştırma yapmaz.
 */
export class SignatureTracker {
  private readonly seen = new Map<string, string | null>();

  constructor(private readonly addresses: readonly string[]) {}

  get known(): boolean {
    return this.addresses.every((address) => this.seen.has(address));
  }

  /** Okunan durumun dayandığı en yeni imzalar. */
  baseline(newest: ReadonlyMap<string, string | null>): void {
    for (const [address, signature] of newest) this.seen.set(address, signature);
  }

  observe(address: string, signature: string | null): boolean {
    if (this.seen.get(address) === signature) return false;
    this.seen.set(address, signature);
    return true;
  }
}

const isoTime = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
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
      return {
        title: 'Receivable listed',
        detail: `for ${formatAmount(num(d.price))}, ${formatDiscount(num(d.price), num(d.face_value))} below its face value`,
      };
    case 'ClaimBought':
      return { title: 'Receivable sold', detail: `to ${str(d.buyer)} for ${formatAmount(num(d.price))}` };
    case 'ClaimCancelled':
      return { title: 'Receivable listing withdrawn' };
    case 'ReleaseVerified':
      return { title: 'Release proof verified', detail: `${formatAmount(num(d.net_amount))} to ${str(d.payee)}` };
    case 'ReleaseRefused':
      return {
        title: 'Release refused by the proof',
        detail: `${formatAmount(num(d.refunded_amount))} refunded to the institution: ${refusalReasons(Number(d.refusal_code)).join('; ')}`,
      };
    case 'Finalized':
      return { title: 'Paid out', detail: `keeper fee ${formatAmount(num(d.keeper_fee))}` };
    case 'JobCancelled':
      return { title: 'Cancelled', detail: `${formatAmount(num(d.refunded_amount))} refunded` };
    case 'JobAgentWalletSynced':
      return { title: 'Agent wallet updated', detail: str(d.agent_wallet) };
    case 'TravelRuleCommitted':
      return { title: 'Travel Rule commitment bound' };
    case 'DisputeRaised':
      return {
        title: 'Dispute raised',
        detail: `by ${str(d.challenger)}, bond ${formatAmount(num(d.bond))}, deadline ${isoTime(Number(num(d.deadline)))}`,
      };
    case 'DisputeVote':
      return {
        title: 'Arbitrator vote',
        detail: `${str(d.arbitrator)}: ${describeResolution(resolutionOf(d.resolution), formatAmount)}; ${String(d.approval_count)} approval(s) in the count`,
      };
    case 'DisputeDecided':
      return { title: 'Dispute decided', detail: describeResolution(resolutionOf(d.resolution), formatAmount) };
    case 'DisputeResolved':
      return {
        title: 'Decision paid out',
        detail: `${formatAmount(num(d.agent_side_amount))} to the agent side, ${formatAmount(num(d.institution_refund))} back to the institution; bond ${formatAmount(num(d.bond_to_agent_side))} to the agent side, ${formatAmount(num(d.bond_returned))} returned`,
      };
    case 'DisputeLapsed':
      return {
        title: 'Dispute lapsed',
        detail: `No decision by the deadline: bond ${formatAmount(num(d.bond_refunded))} refunded to the institution; the job is back to Delivered`,
      };
    case 'MissingProofEscalated':
      return { title: 'Missing proof escalated', detail: `by the agent wallet ${str(d.agent_wallet)}, without a bond` };
    case 'ValidationRecorded':
      return { title: 'Validation recorded' };
    // Verifier event'leri: zaman çizelgesi API'den (indexer) okununca gelir.
    case 'PreflightProofSet': {
      const code = Number(d.refusal_code);
      return {
        title: 'Pre-acceptance proof bound',
        detail:
          code === 0
            ? "the job's terms satisfy the policy"
            : `only temporary rules refuse it now: ${refusalReasons(code).join('; ')}`,
      };
    }
    case 'ComplianceProofSet': {
      const verdict = typeof d.verdict === 'string' ? d.verdict : Object.keys(d.verdict ?? {})[0];
      return verdict === 'compliant'
        ? {
            title: 'Compliance proof bound: compliant',
            detail: `${formatAmount(num(d.net_amount))} to ${str(d.payee)}`,
          }
        : {
            title: 'Compliance proof bound: refused',
            detail: refusalReasons(Number(d.refusal_code)).join('; '),
          };
    }
    case 'ReleaseRecorded':
      return {
        title: 'Release recorded by the verifier',
        detail: `${formatAmount(num(d.net_amount))}; the institution's daily spend is now ${formatAmount(num(d.daily_spent))}`,
      };
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

/**
 * API'nin makbuzu bu içeriğin mi? Zincire tarayıcıda hesaplanan hash yazılır; makbuzun hash'i farklıysa URI
 * başka bir içeriği gösterir ve kullanılmaz. URI `submit_work`'ün sınırına da uymalıdır.
 */
export function receiptProblem(receipt: DeliveryReceipt, hash: Uint8Array): string | null {
  if (receipt.workHash !== hex(hash)) {
    return `The Square API stored content with another SHA-256 (${receipt.workHash}), so its URI is not used.`;
  }
  return deliveryUriProblem(receipt.deliveryUri);
}

/** Yükleme hatasının açıklaması; ne yapılacağıyla birlikte. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof SquareApiError) {
    switch (error.code) {
      case 'forbidden':
        return "Only the job's agent wallet or the agent record's owner can upload its delivery.";
      case 'not_found':
        return 'The Square API has not indexed this job yet; try the upload again in a few seconds.';
      case 'invalid_input':
        return `The Square API refused the file: ${error.apiMessage}`;
      case 'rate_limited':
        return 'The Square API is limiting requests from this wallet; try again shortly.';
    }
  }
  return (error as Error).message;
}
