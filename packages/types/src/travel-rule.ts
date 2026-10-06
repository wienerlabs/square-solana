// Travel Rule kaydı ve API şemaları (BE-23, ADR 0017). Kayıt zincire çıkmaz: API'de zarf şifrelemesiyle saklanır,
// zincire yalnızca salt'lı commitment'ı gider (`commit_travel_rule`, ADR 0015). Alan adları ve kimlik kodları
// IVMS101'den alınmıştır (originator / beneficiary, `primaryIdentifier`, `accountNumber`, `CCPT` …); kayıt
// IVMS101'in tamamı değil, Travel Rule'un istediği alanların düz bir alt kümesidir. Şemalar `strict`'tir:
// commitment kaydın kanonik JSON'u üzerinden hesaplandığı için tanınmayan alan sessizce atılmaz, reddedilir.
import { z } from 'zod';
import { Address, Hex32, I64, U64 } from './primitives.js';

const text = (max: number) => z.string().trim().min(1).max(max);
/** ISO 3166-1 alpha-2. */
const Country = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 ülke kodu bekleniyor');
/** ISO 17442 LEI: 18 harf / rakam ve 2 kontrol rakamı. */
const Lei = z.string().regex(/^[A-Z0-9]{18}[0-9]{2}$/, 'LEI bekleniyor (ISO 17442)');

export const TravelRuleAddressSchema = z
  .object({
    street: text(140).nullable(),
    city: text(70),
    postcode: text(16).nullable(),
    country: Country,
  })
  .strict();
export type TravelRuleAddress = z.infer<typeof TravelRuleAddressSchema>;

/** IVMS101 `NationalIdentifierTypeCode`. */
export const TravelRuleIdentifierTypeSchema = z.enum([
  'ARNU',
  'CCPT',
  'RAID',
  'DRLC',
  'FIIN',
  'TXID',
  'SOCS',
  'IDCD',
  'LEIX',
  'MISC',
]);
export type TravelRuleIdentifierType = z.infer<typeof TravelRuleIdentifierTypeSchema>;

export const TravelRuleNationalIdSchema = z
  .object({
    type: TravelRuleIdentifierTypeSchema,
    value: text(35),
    /** Kimliği veren ülke; LEI'de null. */
    country: Country.nullable(),
  })
  .strict();
export type TravelRuleNationalId = z.infer<typeof TravelRuleNationalIdSchema>;

export const TravelRulePersonKindSchema = z.enum(['natural', 'legal']);

/**
 * Originator ya da beneficiary. Gerçek kişide `primaryIdentifier` soyad, `secondaryIdentifier` ad; tüzel kişide
 * `primaryIdentifier` ticaret unvanıdır ve doğum bilgileri ile `secondaryIdentifier` null'dır.
 */
export const TravelRulePersonSchema = z
  .object({
    kind: TravelRulePersonKindSchema,
    primaryIdentifier: text(100),
    secondaryIdentifier: text(100).nullable(),
    /** Transferin hesabı: Solana cüzdan adresi ya da kurumun hesap numarası. */
    accountNumber: text(100),
    address: TravelRuleAddressSchema.nullable(),
    nationalIdentification: TravelRuleNationalIdSchema.nullable(),
    dateOfBirth: z.iso.date().nullable(),
    placeOfBirth: text(70).nullable(),
    countryOfResidence: Country.nullable(),
  })
  .strict()
  .superRefine((person, ctx) => {
    if (person.kind !== 'legal') return;
    for (const field of ['secondaryIdentifier', 'dateOfBirth', 'placeOfBirth'] as const) {
      if (person[field] !== null) ctx.addIssue({ code: 'custom', path: [field], message: 'tüzel kişide null olmalı' });
    }
  });
export type TravelRulePerson = z.infer<typeof TravelRulePersonSchema>;

export const TravelRuleVaspSchema = z
  .object({
    name: text(100),
    lei: Lei.nullable(),
  })
  .strict();
export type TravelRuleVasp = z.infer<typeof TravelRuleVaspSchema>;

/** Travel Rule kaydı; commitment'ın girdisi (`travelRule.commitment`, RFC 8785 kanonik JSON'u). */
export const TravelRuleRecordSchema = z
  .object({
    originator: TravelRulePersonSchema,
    beneficiary: TravelRulePersonSchema,
    originatingVasp: TravelRuleVaspSchema.nullable(),
    beneficiaryVasp: TravelRuleVaspSchema.nullable(),
    /** Job'un tutarı (settlement mint'inin taban birimi); sunucu job'la karşılaştırır. */
    amount: U64,
    /** Job'un settlement mint'i. */
    mint: Address,
  })
  .strict();
export type TravelRuleRecord = z.infer<typeof TravelRuleRecordSchema>;

export const TravelRulePutSchema = z.object({ record: TravelRuleRecordSchema }).strict();
export type TravelRulePut = z.infer<typeof TravelRulePutSchema>;

/** Saklanan kaydın kişisel veri içermeyen durumu. */
export const TravelRuleStatusSchema = z.object({
  job: Address,
  /** `sha256("square/travel-rule/v1" ‖ job ‖ salt ‖ recordDigest)`; `commitTravelRule`'un argümanı. */
  commitment: Hex32,
  /** Kaydın RFC 8785 kanonik JSON'unun SHA-256'sı. */
  recordDigest: Hex32,
  storedBy: Address,
  storedAt: I64,
  /** Saklama süresinin sonu; sonra kayıt ve salt silinir, commitment ve erişim kaydı kalır. */
  retainUntil: I64,
  /** Kayıt silindiyse zamanı. */
  purgedAt: I64.nullable(),
  /** Zincirde job'a bağlı commitment (`Job.travel_rule_commitment`); bağlı değilse null. */
  chainCommitment: Hex32.nullable(),
  /** Saklanan commitment zincirdekiyle aynı. */
  committed: z.boolean(),
});
export type TravelRuleStatus = z.infer<typeof TravelRuleStatusSchema>;

/** Kaydın açılmış hâli: kişisel veri. Her okuma erişim kaydına yazılır. */
export const TravelRuleDisclosureSchema = z.object({
  status: TravelRuleStatusSchema,
  record: TravelRuleRecordSchema,
  /** Commitment'ın salt'ı; karşı taraf `travelRule.commitment` ile commitment'ı yeniden hesaplar. */
  salt: Hex32,
});
export type TravelRuleDisclosure = z.infer<typeof TravelRuleDisclosureSchema>;

export const TravelRuleGrantCreateSchema = z
  .object({
    /** Kaydı okuyabilecek cüzdan (karşı VASP, denetçi). */
    grantee: Address,
    purpose: text(200),
    expiresAt: I64,
  })
  .strict();
export type TravelRuleGrantCreate = z.infer<typeof TravelRuleGrantCreateSchema>;

export const TravelRuleGrantSchema = z.object({
  job: Address,
  grantee: Address,
  purpose: z.string().min(1).max(200),
  grantedBy: Address,
  grantedAt: I64,
  expiresAt: I64,
  revokedAt: I64.nullable(),
});
export type TravelRuleGrant = z.infer<typeof TravelRuleGrantSchema>;

export const TravelRuleAccessActionSchema = z.enum(['store', 'read', 'grant', 'revoke', 'purge']);
export type TravelRuleAccessAction = z.infer<typeof TravelRuleAccessActionSchema>;

/** Erişim kaydı: kişisel veriye dokunan her işlem. */
export const TravelRuleAccessSchema = z.object({
  id: z.string().min(1),
  job: Address,
  action: TravelRuleAccessActionSchema,
  /** İşlemi yapan cüzdan; saklama süresinin dolmasıyla silmede null. */
  actor: Address.nullable(),
  /** `grant` ve `revoke`'ta izin verilen cüzdan. */
  grantee: Address.nullable(),
  /** İsteğin kimliği (`meta.requestId`); sunucunun kendi işleminde null. */
  requestId: z.string().nullable(),
  at: I64,
});
export type TravelRuleAccess = z.infer<typeof TravelRuleAccessSchema>;
