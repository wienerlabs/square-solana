// Ayna satırlarından API görünümleri (`@squaresdk/solana-types` views). Görünüm zincir hesabını `account`
// alanında aynen taşır; yalnızca adres, türetilmiş alanlar ve tazelik (`slot`, `indexedAt`) eklenir. Her
// görünüm sözleşmenin şemasıyla doğrulanır: şemaya uymayan satır API'ye çıkmaz, hata verir.
import type { AgentCardModel as AgentCardRow, PolicyMetaModel as PolicyMetaRow } from '@squaresdk/solana-db';
import {
  AgentCardSchema,
  AgentViewSchema,
  ClaimViewSchema,
  DisputeViewSchema,
  IndexedEventSchema,
  InstitutionViewSchema,
  JobViewSchema,
  PolicyViewSchema,
  ScreeningViewSchema,
  type AgentView,
  type ClaimView,
  type DisputeView,
  type IndexedEvent,
  type InstitutionView,
  type JobView,
  type PolicyView,
  type ScreeningView,
} from '@squaresdk/solana-types';

/** Satırların ortak alanları. */
export interface MirrorRow {
  address: string;
  account: unknown;
  slot: bigint;
  indexedAt: Date;
}

/** Veritabanı zamanı → Unix saniyesi (sözleşmede i64 zamanlar saniyedir). */
export const unixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

const freshness = (row: { slot: bigint; indexedAt: Date }) => ({
  slot: Number(row.slot),
  indexedAt: unixSeconds(row.indexedAt),
});

export function jobView(
  job: MirrorRow & { agentWallet: string },
  related: {
    claim: (MirrorRow & { buyer: string | null }) | null;
    releaseProof: MirrorRow | null;
    validation: MirrorRow | null;
  },
): JobView {
  return JobViewSchema.parse({
    address: job.address,
    account: job.account,
    // Satılmış alacakta ödeme alıcıya gider (alıcı yalnızca satın almayla atanır).
    payee: related.claim?.buyer ?? job.agentWallet,
    claim: related.claim?.account ?? null,
    releaseProof: related.releaseProof?.account ?? null,
    validation: related.validation?.account ?? null,
    ...freshness(job),
  });
}

export const institutionView = (row: MirrorRow): InstitutionView =>
  InstitutionViewSchema.parse({ address: row.address, account: row.account, ...freshness(row) });

export const policyView = (row: MirrorRow, meta: PolicyMetaRow | null): PolicyView =>
  PolicyViewSchema.parse({
    address: row.address,
    account: row.account,
    meta: meta
      ? { name: meta.name, description: meta.description, labels: meta.labels, updatedAt: unixSeconds(meta.updatedAt) }
      : null,
    ...freshness(row),
  });

export function agentView(
  row: MirrorRow & { agentCardHash: string },
  related: { did: string; card: AgentCardRow | null; reputation: MirrorRow | null },
): AgentView {
  const card = related.card ? AgentCardSchema.safeParse(related.card.content) : null;
  return AgentViewSchema.parse({
    address: row.address,
    account: row.account,
    did: related.did,
    card: card?.success ? card.data : null,
    // Kart, son denetimde zincirdeki hash'le eşleşmiş ve o hash hâlâ zincirdeki değer olmalı.
    cardVerified: related.card !== null && related.card.verified && related.card.contentHash === row.agentCardHash,
    reputation: related.reputation?.account ?? null,
    ...freshness(row),
  });
}

export const claimView = (row: MirrorRow & { job: string }): ClaimView =>
  ClaimViewSchema.parse({ address: row.address, job: row.job, account: row.account, ...freshness(row) });

export function disputeView(
  row: { job: string; jobStatus: string; institution: string; agentRecord: string; slot: bigint; indexedAt: Date },
  jobAccount: unknown,
): DisputeView {
  return DisputeViewSchema.parse({
    job: row.job,
    jobStatus: row.jobStatus,
    institution: row.institution,
    agentRecord: row.agentRecord,
    dispute: (jobAccount as { dispute?: unknown } | null)?.dispute,
    ...freshness(row),
  });
}

export const screeningView = (
  row: MirrorRow & { status: string; expiresAt: bigint },
  nowSeconds: number,
): ScreeningView =>
  ScreeningViewSchema.parse({
    address: row.address,
    account: row.account,
    fresh: row.status === 'clear' && row.expiresAt > BigInt(nowSeconds),
    ...freshness(row),
  });

export const eventView = (row: {
  signature: string;
  slot: bigint;
  blockTime: bigint | null;
  instructionIndex: number;
  eventIndex: number;
  payload: unknown;
}): IndexedEvent =>
  IndexedEventSchema.parse({
    signature: row.signature,
    slot: Number(row.slot),
    blockTime: row.blockTime === null ? null : Number(row.blockTime),
    instructionIndex: row.instructionIndex,
    eventIndex: row.eventIndex,
    payload: row.payload,
  });
