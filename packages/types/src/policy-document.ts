// Kurumun harcama politikası (zincire ÇIKMAZ). @squaresdk/solana-policy bunu salt'la Poseidon
// commitment'a çevirir; zincirde yalnızca commitment ve public günlük tavan durur (BC-17).
// Bu şema API'ye gönderilmez; API yalnızca `PolicyMeta`'yı görür.
//
// Alanlar release devresinin politika girdileridir (docs/design/release-circuit.md §4–§5, BC-19):
// devrenin kabul edemeyeceği bir politika burada reddedilir. Aperture `@aperture/types`
// `PolicySchema` / `TimeRestriction`'dan uyarlandı (BE-07): saat dilimi yok (devre UTC), tek
// pencere, liste boyları devrenin yuvaları kadar.
import { z } from 'zod';
import { Address, Hex32, U64 } from './primitives.js';

/** `ReleaseCompliance(10, 10, 8)` (circuits/payment-compliance/payment.circom) yuva sayıları. */
export const POLICY_CIRCUIT_LIMITS = Object.freeze({
  tokenWhitelist: 10,
  blockedPayees: 10,
  allowedCategories: 8,
  /** Kategori dizesinin UTF-8 bayt sınırı (32 bayta sıfırla doldurulup alan elemanına çevrilir). */
  categoryBytes: 32,
});

/** Devrenin `time_days_bitmask` sırası: Pazartesi = 0. bit. */
export const DAYS_OF_WEEK = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const DayOfWeekSchema = z.enum(DAYS_OF_WEEK);
export type DayOfWeek = z.infer<typeof DayOfWeekSchema>;

const distinct = <T>(items: readonly T[]) => new Set(items).size === items.length;
const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/** Ödeme kategorisi: 1–32 bayt UTF-8. */
export const PolicyCategorySchema = z
  .string()
  .refine((value) => utf8Length(value) >= 1 && utf8Length(value) <= POLICY_CIRCUIT_LIMITS.categoryBytes, {
    message: `kategori 1–${POLICY_CIRCUIT_LIMITS.categoryBytes} bayt UTF-8 olmalı`,
  });

/**
 * İzinli zaman penceresi, UTC. İki uç saat dahildir (09–17 → 09:00:00–17:59:59); pencere gece
 * yarısını geçemez, bu yüzden `startHourUtc ≤ endHourUtc`.
 */
export const TimeWindowSchema = z
  .object({
    days: z.array(DayOfWeekSchema).min(1).max(7).refine(distinct, { message: 'gün tekrar edemez' }),
    startHourUtc: z.number().int().min(0).max(23),
    endHourUtc: z.number().int().min(0).max(23),
  })
  .refine((window) => window.startHourUtc <= window.endHourUtc, {
    message: 'pencere gece yarısını geçemez (startHourUtc ≤ endHourUtc)',
    path: ['endHourUtc'],
  });
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

export const PolicyDocumentSchema = z.object({
  /** square_policy `Institution` PDA'sı (devrede `operator_id_field`). */
  institution: Address,
  /** Zincirdeki `Policy.policyId` (32 bayt hex). */
  policyId: Hex32,
  /** Zincirdeki `Policy.version`. */
  version: z.number().int().min(1),
  /** Public günlük tavan; zincirdeki `Policy.dailyCeiling` ile aynı olmalı (settlement mint atomik birimi). */
  dailyCeiling: U64,
  /** Gizli günlük tavan (kural 2). */
  maxDaily: U64,
  /** İşlem başı tavan (kural 1). */
  maxPerTx: U64,
  /** Ödeme yapılabilecek mint'ler (kural 3). Escrow tek settlement mint kullanır; o mint listede olmalı. */
  tokenWhitelist: z
    .array(Address)
    .min(1)
    .max(POLICY_CIRCUIT_LIMITS.tokenWhitelist)
    .refine(distinct, { message: 'mint tekrar edemez' }),
  /** Ödeme alamayacak cüzdanlar (kural 4). */
  blockedPayees: z
    .array(Address)
    .max(POLICY_CIRCUIT_LIMITS.blockedPayees)
    .refine(distinct, { message: 'adres tekrar edemez' }),
  /** İzinli ödeme kategorileri (kural 5); boş liste her release'i reddeder, bu yüzden en az bir tane. */
  allowedCategories: z
    .array(PolicyCategorySchema)
    .min(1)
    .max(POLICY_CIRCUIT_LIMITS.allowedCategories)
    .refine(distinct, { message: 'kategori tekrar edemez' }),
  /** Zaman penceresi (kural 6); null = her an. */
  timeWindow: TimeWindowSchema.nullable(),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;
