// Kurumun harcama politikası (zincire ÇIKMAZ). @squaresdk/solana-policy bunu salt'la Poseidon
// commitment'a çevirir; zincirde yalnızca commitment ve public günlük tavan durur (BC-17).
// Bu şema API'ye gönderilmez; API yalnızca `PolicyMeta`'yı görür. Ayrıntılar BE-10'da.
import { z } from 'zod';
import { Address, Hex32, U64 } from './primitives.js';

export const TimeWindowSchema = z.object({
  /** 0 = pazar … 6 = cumartesi. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startHourUtc: z.number().int().min(0).max(23),
  endHourUtc: z.number().int().min(1).max(24),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const PolicyDocumentSchema = z.object({
  /** Zincirdeki `Policy.policyId` (32 bayt hex). */
  policyId: Hex32,
  version: z.number().int().min(1),
  /** Zincirdeki public tavanla aynı olmalı (settlement mint atomik birimi). */
  dailyCeiling: U64,
  maxPerPayment: U64,
  /** Ödeme alabilecek agent kayıtları; boş = kısıt yok. */
  allowedAgentRecords: z.array(Address).max(1024),
  blockedPayees: z.array(Address).max(1024),
  allowedCategories: z.array(z.string().min(1).max(64)).max(64),
  timeWindows: z.array(TimeWindowSchema).max(14),
  /** Settlement mint dışındaki değerler v0.1.0'da reddedilir (BC-22). */
  mintWhitelist: z.array(Address).min(1).max(8),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
