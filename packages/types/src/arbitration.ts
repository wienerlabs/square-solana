// Uyuşmazlık araçları (BE-22): dispute kanıtı, arbitrator kuyruğu ve oyu, arbitrator webhook abonelikleri ve
// bildirim gövdesi. Kurallar: apps/api README "Uyuşmazlık" bölümü; zincir tarafı ADR 0016.
import { z } from 'zod';
import { DisputeResolutionSchema } from './generated/idl.js';
import { IndexedEventSchema } from './events.js';
import { Address, Hex32, I64, Signature, U64 } from './primitives.js';
import { DisputeViewSchema } from './views.js';

// ---------------------------------------------------------------- kanıt

/** Kanıtı yükleyenin dispute'taki tarafı. */
export const DisputeEvidenceRoleSchema = z.enum(['institution', 'agent', 'arbitrator']);
export type DisputeEvidenceRole = z.infer<typeof DisputeEvidenceRoleSchema>;

export const DisputeEvidenceSchema = z.object({
  id: z.string().min(1),
  job: Address,
  /** İçeriğin SHA-256'sı; kurumun kanıtında `raise_dispute`'un `reason_hash` argümanı. */
  reasonHash: Hex32,
  contentType: z.string().min(1).max(120),
  size: z.number().int().min(0),
  role: DisputeEvidenceRoleSchema,
  uploadedBy: Address,
  /** Zincirdeki dispute'un `reasonHash`'i bu içeriğin hash'i mi. */
  isDisputeReason: z.boolean(),
  createdAt: I64,
});
export type DisputeEvidence = z.infer<typeof DisputeEvidenceSchema>;

// ---------------------------------------------------------------- oy ve kuyruk

/** `DisputeVote` event'inden bir oy. */
export const DisputeVoteRecordSchema = z.object({
  arbitrator: Address,
  resolution: DisputeResolutionSchema,
  /** Oyla birlikte sayımdaki onay sayısı (set değişiminde sayım sıfırlanır). */
  approvalCount: z.number().int().min(1).max(7),
  signature: Signature,
  slot: z.number().int().min(0),
  blockTime: I64.nullable(),
});
export type DisputeVoteRecord = z.infer<typeof DisputeVoteRecordSchema>;

export const ArbitrationQueueItemSchema = z.object({
  dispute: DisputeViewSchema,
  /** Dispute açıldıktan sonraki oylar, eskiden yeniye. */
  votes: z.array(DisputeVoteRecordSchema),
  /** Oturumdaki arbitrator güncel sayımda oy verdi mi. */
  hasVoted: z.boolean(),
  /** Oy verilebilir: oy yok ve son tarih geçmedi. */
  canVote: z.boolean(),
  /** Karar için gereken onay (M). */
  threshold: z.number().int().min(2).max(7),
  evidence: z.array(DisputeEvidenceSchema),
});
export type ArbitrationQueueItem = z.infer<typeof ArbitrationQueueItemSchema>;

/** `resolve_dispute` oyu için imzasız tx isteği. */
export const DisputeVoteRequestSchema = z.object({
  /** Oy; `pending` olamaz. */
  resolution: DisputeResolutionSchema,
  /** Boşsa arbitrator'ın kendisi. */
  feePayer: Address.nullable(),
  /** Mikro-lamport cinsinden priority fee; boşsa sunucu profili. */
  computeUnitPrice: U64.nullable(),
});
export type DisputeVoteRequest = z.infer<typeof DisputeVoteRequestSchema>;

// ---------------------------------------------------------------- bildirim

/** Standard Webhooks `type` değerleri. */
export const ArbitrationEventTypeSchema = z.enum([
  'dispute.raised',
  'dispute.escalated',
  'dispute.vote',
  'dispute.decided',
  'dispute.deadline',
]);
export type ArbitrationEventType = z.infer<typeof ArbitrationEventTypeSchema>;

export const ArbitrationWebhookSchema = z.object({
  id: z.string().min(1),
  url: z.url().max(512),
  events: z.array(ArbitrationEventTypeSchema).min(1),
  createdAt: I64,
});
export type ArbitrationWebhook = z.infer<typeof ArbitrationWebhookSchema>;

export const ArbitrationWebhookCreateSchema = z.object({
  url: z.url().max(512),
  events: z.array(ArbitrationEventTypeSchema).min(1),
});
export type ArbitrationWebhookCreate = z.infer<typeof ArbitrationWebhookCreateSchema>;

export const ArbitrationWebhookCreatedSchema = z.object({
  webhook: ArbitrationWebhookSchema,
  /** Standard Webhooks sırrı (`whsec_…`); yalnızca bu yanıtta döner. */
  secret: z.string().min(32),
});
export type ArbitrationWebhookCreated = z.infer<typeof ArbitrationWebhookCreatedSchema>;

/** Webhook gövdesi; başlıklar Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`). */
export const ArbitrationNotificationSchema = z.object({
  type: ArbitrationEventTypeSchema,
  /** Bildirimin oluşturulduğu Unix saniyesi. */
  timestamp: I64,
  job: Address,
  /** Dispute'un son tarihi; dispute aynası henüz yoksa null. */
  deadline: I64.nullable(),
  /** Bildirimi doğuran zincir event'i; `dispute.deadline`'da null. */
  event: IndexedEventSchema.nullable(),
});
export type ArbitrationNotification = z.infer<typeof ArbitrationNotificationSchema>;
