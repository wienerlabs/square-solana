// API okuma görünümleri (indexer DB'den). Zincirdeki hesap `account` alanında, IDL'den üretilen
// şemayla aynen taşınır; görünümler yalnızca adres ve türetilmiş alanları ekler.
import { z } from 'zod';
import {
  AgentRecordSchema,
  AgentReputationSchema,
  ClaimListingSchema,
  DisputeInfoSchema,
  InstitutionSchema,
  JobSchema,
  JobStatusSchema,
  PolicySchema,
  ReleaseProofSchema,
  ScreeningRecordSchema,
  ValidationRecordSchema,
} from './generated/idl.js';
import { AgentCardSchema } from './agent-card.js';
import { Address, Did, I64 } from './primitives.js';

/** Zincir durumunun okunduğu slot ve indexer'ın son güncelleme zamanı. */
const Freshness = { slot: z.number().int().min(0), indexedAt: I64 };

export const JobViewSchema = z.object({
  address: Address,
  account: JobSchema,
  /** Ödemenin gideceği adres: satılmış alacakta alıcı, değilse `agentWallet`. */
  payee: Address,
  claim: ClaimListingSchema.nullable(),
  releaseProof: ReleaseProofSchema.nullable(),
  validation: ValidationRecordSchema.nullable(),
  ...Freshness,
});
export type JobView = z.infer<typeof JobViewSchema>;

export const InstitutionViewSchema = z.object({ address: Address, account: InstitutionSchema, ...Freshness });
export type InstitutionView = z.infer<typeof InstitutionViewSchema>;

/** Politikanın herkese açık meta verisi; kuralların kendisi asla API'ye gelmez. */
export const PolicyMetaSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  labels: z.array(z.string().min(1).max(40)).max(20),
  updatedAt: I64,
});
export type PolicyMeta = z.infer<typeof PolicyMetaSchema>;

export const PolicyViewSchema = z.object({
  address: Address,
  account: PolicySchema,
  meta: PolicyMetaSchema.nullable(),
  ...Freshness,
});
export type PolicyView = z.infer<typeof PolicyViewSchema>;

export const AgentViewSchema = z.object({
  address: Address,
  account: AgentRecordSchema,
  did: Did,
  card: AgentCardSchema.nullable(),
  /** Kartın SHA-256'sı zincirdeki `agentCardHash` ile eşleşiyor mu. */
  cardVerified: z.boolean(),
  reputation: AgentReputationSchema.nullable(),
  ...Freshness,
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const ClaimViewSchema = z.object({ address: Address, job: Address, account: ClaimListingSchema, ...Freshness });
export type ClaimView = z.infer<typeof ClaimViewSchema>;

export const DisputeViewSchema = z.object({
  job: Address,
  jobStatus: JobStatusSchema,
  institution: Address,
  agentRecord: Address,
  dispute: DisputeInfoSchema,
  ...Freshness,
});
export type DisputeView = z.infer<typeof DisputeViewSchema>;

export const ScreeningViewSchema = z.object({
  address: Address,
  account: ScreeningRecordSchema,
  /** `status == clear` ve `expiresAt > now`. */
  fresh: z.boolean(),
  ...Freshness,
});
export type ScreeningView = z.infer<typeof ScreeningViewSchema>;
