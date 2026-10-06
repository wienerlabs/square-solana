// Travel Rule kaydı ve commitment'ı (FE-18, akışın 3. adımı; ADR 0015). Eşiği aşan işte kurum fonlamadan
// önce originator (kurum) ve beneficiary (agent'ın işletmecisi) bilgisini girer; kayıt ve 32 baytlık salt
// bu tarayıcıda şifreli kalır (travel-rule-local.ts), zincire yalnızca SDK'nın hesapladığı commitment
// gider (`commit_travel_rule`). Alanlar IVMS 101'in asgarisidir (FATF Tavsiye 16): ad, hesap, originator
// için adres ya da ulusal kimlik ya da doğum tarihi ve yeri, VASP. Kaydın kalıcı şeması BE-23'ündür;
// commitment hangi kayıt bağlandıysa onun üzerinden doğrulanır, şema değişse de kural aynı kalır.
import { PublicKey } from '@solana/web3.js';
import { travelRule } from '@squaresdk/solana-sdk';
import { z } from 'zod';
import { bytesToHex, hexToBytes } from './policy-draft';

const HEX32 = /^[0-9a-f]{64}$/;

/** Alanların üst sınırı (karakter); IVMS 101'in ad ve adres satırı sınırlarıyla aynı. */
export const PARTY_TEXT_MAX = 100;
export const ADDRESS_MAX = 210;

export const PARTY_KINDS = ['legal', 'natural'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/** Formdaki bir taraf; değerler kullanıcının yazdığı metindir, boş alan "verilmedi" demektir. */
export interface PartyForm {
  kind: PartyKind;
  name: string;
  geographicAddress: string;
  country: string;
  nationalId: string;
  dateOfBirth: string;
  placeOfBirth: string;
  vaspName: string;
  vaspLei: string;
}

export interface TravelRuleForm {
  originator: PartyForm;
  beneficiary: PartyForm;
}

export const emptyParty = (kind: PartyKind = 'legal'): PartyForm => ({
  kind,
  name: '',
  geographicAddress: '',
  country: '',
  nationalId: '',
  dateOfBirth: '',
  placeOfBirth: '',
  vaspName: '',
  vaspLei: '',
});

export const emptyTravelRuleForm = (): TravelRuleForm => ({
  originator: emptyParty('legal'),
  beneficiary: emptyParty('legal'),
});

/**
 * LEI (ISO 17442): 18 karakter ve iki kontrol hanesi; ISO 7064 MOD 97-10 ile harfler 10..35 sayılır ve
 * bütün sayının 97'ye bölümünden kalan 1'dir.
 */
export function isValidLei(lei: string): boolean {
  if (!/^[0-9A-Z]{18}[0-9]{2}$/.test(lei)) return false;
  let rest = 0;
  for (const char of lei) {
    const value = Number.parseInt(char, 36);
    rest = value > 9 ? (rest * 100 + value) % 97 : (rest * 10 + value) % 97;
  }
  return rest === 1;
}

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters.`);

const PartySchema = z
  .object({
    kind: z.enum(PARTY_KINDS),
    name: text(PARTY_TEXT_MAX).min(1, 'Required.'),
    geographicAddress: text(ADDRESS_MAX),
    country: z
      .string()
      .trim()
      .toUpperCase()
      .refine((value) => value === '' || /^[A-Z]{2}$/.test(value), 'Two-letter ISO 3166-1 country code.'),
    nationalId: text(PARTY_TEXT_MAX),
    dateOfBirth: z
      .string()
      .trim()
      .refine((value) => value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value), 'Use YYYY-MM-DD.'),
    placeOfBirth: text(PARTY_TEXT_MAX),
    vaspName: text(PARTY_TEXT_MAX).min(1, 'Required. For a self-hosted wallet write “Self-hosted”.'),
    vaspLei: z
      .string()
      .trim()
      .toUpperCase()
      .refine((value) => value === '' || isValidLei(value), 'Not a valid LEI (20 characters, ISO 17442 check digits).'),
  })
  .superRefine((party, ctx) => {
    if (party.kind === 'legal' && (party.dateOfBirth !== '' || party.placeOfBirth !== '')) {
      const path = party.dateOfBirth !== '' ? 'dateOfBirth' : 'placeOfBirth';
      ctx.addIssue({ code: 'custom', path: [path], message: 'Only a natural person has a date and place of birth.' });
    }
    if (party.dateOfBirth !== '' && party.placeOfBirth === '')
      ctx.addIssue({ code: 'custom', path: ['placeOfBirth'], message: 'Give the place of birth with the date.' });
    if (party.placeOfBirth !== '' && party.dateOfBirth === '')
      ctx.addIssue({ code: 'custom', path: ['dateOfBirth'], message: 'Give the date of birth with the place.' });
    if (party.geographicAddress !== '' && party.country === '')
      ctx.addIssue({ code: 'custom', path: ['country'], message: 'Give the country of the address.' });
  });

export type CheckedParty = z.infer<typeof PartySchema>;

/** Doğum tarihi gerçek bir gün ve bugünden önce olmalı (`today`: YYYY-MM-DD, UTC). */
function birthDateProblem(value: string, today: string): string | null {
  if (value === '') return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'Not a real date.';
  if (value >= today) return 'The date of birth must be in the past.';
  return null;
}

export type TravelRuleCheck =
  | { ok: true; value: { originator: CheckedParty; beneficiary: CheckedParty } }
  | { ok: false; errors: Record<string, string> };

/**
 * Formun doğrulaması; hatalar `originator.name` gibi alan yollarıyla, alan başına ilki. Originator adres,
 * ulusal kimlik ya da doğum tarihi ve yerinden birini verir (FATF Tavsiye 16); beneficiary için ad, hesap
 * ve VASP yeter.
 */
export function checkTravelRuleForm(form: TravelRuleForm, today: string): TravelRuleCheck {
  const parsed = z.object({ originator: PartySchema, beneficiary: PartySchema }).safeParse(form);
  const errors: Record<string, string> = {};
  const add = (path: string, message: string) => {
    errors[path] ??= message;
  };
  if (!parsed.success) for (const issue of parsed.error.issues) add(issue.path.join('.'), issue.message);
  for (const role of ['originator', 'beneficiary'] as const) {
    const problem = birthDateProblem(form[role].dateOfBirth.trim(), today);
    if (problem) add(`${role}.dateOfBirth`, problem);
  }
  const originator = form.originator;
  const identified =
    originator.geographicAddress.trim() !== '' ||
    originator.nationalId.trim() !== '' ||
    (originator.dateOfBirth.trim() !== '' && originator.placeOfBirth.trim() !== '');
  if (!identified)
    add(
      'originator.identification',
      'Give the originator’s address, a national identifier or the date and place of birth.',
    );
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: parsed.data };
}

const RecordPartySchema = z
  .object({
    type: z.enum(PARTY_KINDS),
    name: z.string().min(1),
    /** Taraftaki cüzdan: originator için kurum, beneficiary için işin ödeme cüzdanı. */
    account: z.string().min(1),
    geographicAddress: z
      .object({ address: z.string().min(1), country: z.string().length(2) })
      .strict()
      .optional(),
    nationalIdentification: z.string().min(1).optional(),
    dateAndPlaceOfBirth: z
      .object({ date: z.string(), place: z.string().min(1) })
      .strict()
      .optional(),
    vasp: z.object({ name: z.string().min(1), lei: z.string().length(20).optional() }).strict(),
  })
  .strict();

export const TravelRuleRecordSchema = z
  .object({
    originator: RecordPartySchema,
    beneficiary: RecordPartySchema,
    /** İşin tutarı, settlement mint'inin taban biriminde (ondalık metin). */
    amount: z.string().regex(/^(0|[1-9][0-9]*)$/),
    /** Settlement mint'i (base58). */
    asset: z.string().min(1),
  })
  .strict();
export type TravelRuleRecord = z.infer<typeof TravelRuleRecordSchema>;
export type RecordParty = z.infer<typeof RecordPartySchema>;

function recordParty(party: CheckedParty, account: string): RecordParty {
  // Boş alan kayda girmez: kanonik JSON'da "verilmedi" ile "boş metin" ayrı özet verirdi.
  return {
    type: party.kind,
    name: party.name,
    account,
    ...(party.geographicAddress !== '' && {
      geographicAddress: { address: party.geographicAddress, country: party.country },
    }),
    ...(party.nationalId !== '' && { nationalIdentification: party.nationalId }),
    ...(party.dateOfBirth !== '' && { dateAndPlaceOfBirth: { date: party.dateOfBirth, place: party.placeOfBirth } }),
    vasp: { name: party.vaspName, ...(party.vaspLei !== '' && { lei: party.vaspLei }) },
  };
}

/** Doğrulanmış formdan kayıt: hesaplar zincirdeki cüzdanlardır, tutar ve varlık işinkidir. */
export function buildTravelRuleRecord(
  checked: { originator: CheckedParty; beneficiary: CheckedParty },
  context: { originatorAccount: PublicKey; beneficiaryAccount: PublicKey; amount: bigint; asset: PublicKey },
): TravelRuleRecord {
  return {
    originator: recordParty(checked.originator, context.originatorAccount.toBase58()),
    beneficiary: recordParty(checked.beneficiary, context.beneficiaryAccount.toBase58()),
    amount: context.amount.toString(),
    asset: context.asset.toBase58(),
  };
}

/** Şifreli depodaki bir kayıt: hangi işe hangi salt ve kayıtla hangi commitment bağlandı. */
export const TravelRuleEntrySchema = z
  .object({
    job: z.string().min(32).max(44),
    salt: z.string().regex(HEX32),
    record: TravelRuleRecordSchema,
    commitment: z.string().regex(HEX32),
    /** Kaydın oluşturulduğu an (Unix saniye, yerel saat). */
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type TravelRuleEntry = z.infer<typeof TravelRuleEntrySchema>;

/** Commitment SDK'nın `travelRule.commitment`'ıdır; zincirdeki `square_common::travel_rule` ile aynı. */
export const travelRuleCommitment = (job: PublicKey, salt: Uint8Array, record: unknown): Uint8Array =>
  travelRule.commitment({ job, salt, record });

/** Yeni kayıt: salt CSPRNG'den (SDK `generateSalt`), commitment kayıttan hesaplanır. */
export function createTravelRuleEntry(params: {
  job: PublicKey;
  record: TravelRuleRecord;
  now: number;
  salt?: Uint8Array;
}): TravelRuleEntry {
  const salt = params.salt ?? travelRule.generateSalt();
  return {
    job: params.job.toBase58(),
    salt: bytesToHex(salt),
    record: params.record,
    commitment: bytesToHex(travelRuleCommitment(params.job, salt, params.record)),
    createdAt: params.now,
  };
}

/** Kaydın commitment'ı, saklanan değere güvenmeden kayıttan ve salt'tan yeniden hesaplanır. */
export const recomputeCommitment = (entry: TravelRuleEntry): string =>
  bytesToHex(travelRuleCommitment(new PublicKey(entry.job), hexToBytes(entry.salt), entry.record));

export const isBound = (commitment: Uint8Array) => commitment.some((byte) => byte !== 0);

/** `square_common::travel_rule::required`: eşik açık ve tutar eşiğe eşit ya da üstünde. */
export const travelRuleRequired = (amount: bigint, threshold: bigint) => threshold > 0n && amount >= threshold;

export type TravelRuleVerification =
  | { state: 'notBound' }
  | { state: 'noRecord' }
  | { state: 'match'; entry: TravelRuleEntry }
  | { state: 'mismatch'; local: string };

/**
 * Zincirdeki commitment'ı yerel kayıtlarla karşılaştırır: bu işin kayıtlarından commitment'ı yeniden
 * hesaplanınca zincirdekine eşit olan aranır. Yoksa en son kaydın commitment'ı `mismatch` ile döner.
 */
export function verifyTravelRule(
  entries: readonly TravelRuleEntry[],
  job: string,
  chainCommitment: Uint8Array,
): TravelRuleVerification {
  if (!isBound(chainCommitment)) return { state: 'notBound' };
  const chain = bytesToHex(chainCommitment);
  const own = entries.filter((entry) => entry.job === job);
  if (own.length === 0) return { state: 'noRecord' };
  const match = own.find((entry) => recomputeCommitment(entry) === chain);
  if (match) return { state: 'match', entry: match };
  const latest = own.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
  return { state: 'mismatch', local: recomputeCommitment(latest) };
}

export type TravelRuleStatus = 'notRequired' | 'pending' | 'bound' | 'missing';

/**
 * İşin Travel Rule durumu: commitment bağlıysa `bound`; gerekiyor ve iş `Open`'sa `pending` (fonlama
 * bekliyor); gerekiyor ama iş fonlama aşamasını geçtiyse `missing` (eşik sonradan değişti); değilse
 * `notRequired`.
 */
export function travelRuleStatus(job: {
  status: string;
  amount: bigint;
  commitment: Uint8Array;
  threshold: bigint;
}): TravelRuleStatus {
  if (isBound(job.commitment)) return 'bound';
  if (!travelRuleRequired(job.amount, job.threshold)) return 'notRequired';
  return job.status === 'open' ? 'pending' : 'missing';
}

export const TRAVEL_RULE_STATUS_TEXT: Readonly<Record<TravelRuleStatus, string>> = {
  notRequired: 'Not required',
  pending: 'Waiting for the commitment',
  bound: 'Commitment bound',
  missing: 'No commitment',
};

/**
 * Fonlamayı kapatan Travel Rule sebebi; fonlanabilirse null. Eşik üstünde zincirdeki commitment ile bu
 * tarayıcıdaki kaydın commitment'ı eşleşmeden fonlanmaz: başka bir kayda bağlı iş fonlanmasın.
 * `verification` null: kayıtlar kilitli.
 */
export function travelRuleFundBlock(params: {
  required: boolean;
  chainCommitment: Uint8Array;
  verification: TravelRuleVerification | null;
}): string | null {
  if (!params.required) return null;
  if (!isBound(params.chainCommitment))
    return 'Jobs of this size need a Travel Rule commitment before funding: fill in the originator and beneficiary and bind the commitment.';
  const verification = params.verification;
  if (!verification)
    return 'Unlock the Travel Rule records to check the bound commitment against your record before funding.';
  if (verification.state === 'noRecord')
    return 'The bound Travel Rule commitment has no record in this browser. Restore the encrypted export or bind a new commitment before funding.';
  if (verification.state === 'mismatch')
    return 'The bound Travel Rule commitment does not match your record. Bind the commitment again before funding.';
  return null;
}
