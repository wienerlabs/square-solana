// Denetim görünümü (FE-12): job'un herkese açık uyum geçmişi. Event'ler Square API'nin indexer'ından okunur
// (`listEvents({ job })`: escrow event'leri ile verifier'ın ispat bağlama ve release kayıtları, tam geçmiş);
// API yoksa RPC'nin son işlemlerinden. Job, ispat ve validation kaydı zincirden okunur. Politikanın kuralları
// zincirde yoktur, yalnızca commitment'ı vardır; sayfa da göstermez. Görünen, ispatın kararı ve sebepleridir.
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { IndexedEvent } from '@squaresdk/solana-types';
import type { Cluster } from './config';
import type { TimelineEntry } from './job-detail';
import { unwrap } from './square-api';

/** API'nin sayfa üst sınırı (`limit` 1–200). */
export const AUDIT_PAGE_LIMIT = 200;
/** Okunan en fazla event; fazlası varsa sayfa söyler. */
export const AUDIT_MAX_EVENTS = 1_000;

export interface AuditEvents {
  entries: TimelineEntry[];
  /** Job'un bütün event'leri; `entries.length`'ten büyükse geçmiş kesilmiştir. */
  total: number;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** API event'i zaman çizelgesi girdisi olarak: alan adları IDL'deki gibi snake_case (`describeJobEvent`). */
export function timelineEntryOf(event: IndexedEvent): TimelineEntry {
  const data = event.payload.data as Record<string, unknown>;
  return {
    signature: event.signature,
    slot: event.slot,
    blockTime: event.blockTime,
    event: {
      name: event.payload.name,
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [snake(key), value])),
    },
  };
}

/** Job'un event'leri, eskiden yeniye; sayfalar `AUDIT_MAX_EVENTS`'e kadar okunur. */
export async function readAuditEvents(api: SquareApi, job: string): Promise<AuditEvents> {
  const events: IndexedEvent[] = [];
  for (let page = 1; ; page += 1) {
    const envelope = await api.listEvents({ job, page, limit: AUDIT_PAGE_LIMIT });
    const items = unwrap(envelope);
    events.push(...items);
    const total = envelope.meta.total ?? events.length;
    if (items.length < AUDIT_PAGE_LIMIT || events.length >= Math.min(total, AUDIT_MAX_EVENTS)) {
      return { entries: events.slice(0, AUDIT_MAX_EVENTS).map(timelineEntryOf), total };
    }
  }
}

export interface ProofDecision {
  signature: string;
  blockTime: number | null;
  compliant: boolean;
  refusalCode: number;
  payee: string;
  netAmount: bigint;
}

const verdictOf = (value: unknown) =>
  typeof value === 'string' ? value : Object.keys((value ?? {}) as Record<string, unknown>)[0];

/** Her ispat bağlaması (verifier `ComplianceProofSet`), eskiden yeniye: kararı, ret kodu ve kamu girdileri. */
export function proofHistory(entries: readonly TimelineEntry[]): ProofDecision[] {
  return entries
    .filter((entry) => entry.event.name === 'ComplianceProofSet')
    .map(({ signature, blockTime, event: { data } }) => ({
      signature,
      blockTime,
      compliant: verdictOf(data.verdict) === 'compliant',
      refusalCode: Number(data.refusal_code),
      payee: String(data.payee),
      netAmount: BigInt(String(data.net_amount)),
    }));
}

/**
 * İşlemin Solana Explorer bağlantısı. localnet'te explorer uygulamanın RPC'sine bağlanır (`customUrl`); RPC
 * adresi bağlantıya girer, o yüzden yalnızca localnet'te.
 */
export function explorerTxUrl(signature: string, cluster: Cluster, rpcUrl: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (cluster === 'mainnet-beta') return base;
  if (cluster === 'localnet') return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  return `${base}?cluster=${cluster}`;
}
