import { PublicKey } from '@solana/web3.js';
import { travelRule } from '@squaresdk/solana-sdk';
import {
  TravelRuleIdentifierTypeSchema,
  TravelRuleRecordSchema,
  type TravelRuleDisclosure,
  type TravelRuleIdentifierType,
  type TravelRulePerson,
  type TravelRuleRecord,
  type TravelRuleVasp,
} from '@squaresdk/solana-types';
import { bytesToHex, hexToBytes } from './policy-draft';

export const PERSON_KINDS = ['legal', 'natural'] as const;
export type PersonKind = (typeof PERSON_KINDS)[number];

export const IDENTIFIER_TYPES: readonly TravelRuleIdentifierType[] = TravelRuleIdentifierTypeSchema.options;

export const IDENTIFIER_LABELS: Readonly<Record<TravelRuleIdentifierType, string>> = {
  ARNU: 'Alien registration number',
  CCPT: 'Passport number',
  RAID: 'Registration authority identifier',
  DRLC: 'Driver license number',
  FIIN: 'Foreign investment identity number',
  TXID: 'Tax identification number',
  SOCS: 'Social security number',
  IDCD: 'Identity card number',
  LEIX: 'Legal Entity Identifier (LEI)',
  MISC: 'Other identifier',
};

export interface PersonForm {
  kind: PersonKind;
  primaryIdentifier: string;
  secondaryIdentifier: string;
  street: string;
  city: string;
  postcode: string;
  country: string;
  idType: TravelRuleIdentifierType | '';
  idValue: string;
  idCountry: string;
  dateOfBirth: string;
  placeOfBirth: string;
  countryOfResidence: string;
}

export interface VaspForm {
  name: string;
  lei: string;
}

export interface TravelRuleForm {
  originator: PersonForm;
  beneficiary: PersonForm;
  originatingVasp: VaspForm;
  beneficiaryVasp: VaspForm;
}

export const PERSON_ROLES = ['originator', 'beneficiary'] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];
export const VASP_ROLES = ['originatingVasp', 'beneficiaryVasp'] as const;
export type VaspRole = (typeof VASP_ROLES)[number];

export const emptyPerson = (kind: PersonKind = 'legal'): PersonForm => ({
  kind,
  primaryIdentifier: '',
  secondaryIdentifier: '',
  street: '',
  city: '',
  postcode: '',
  country: '',
  idType: '',
  idValue: '',
  idCountry: '',
  dateOfBirth: '',
  placeOfBirth: '',
  countryOfResidence: '',
});

export const emptyTravelRuleForm = (): TravelRuleForm => ({
  originator: emptyPerson('legal'),
  beneficiary: emptyPerson('legal'),
  originatingVasp: { name: '', lei: '' },
  beneficiaryVasp: { name: '', lei: '' },
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

const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
const upper = (value: string) => value.trim().toUpperCase();

function birthDateProblem(value: string, today: string): string | null {
  if (!DATE.test(value)) return 'Use YYYY-MM-DD.';
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return 'Not a real date.';
  if (value >= today) return 'The date of birth must be in the past.';
  return null;
}

function hasAddress(person: PersonForm): boolean {
  return [person.street, person.city, person.postcode, person.country].some((value) => value.trim() !== '');
}

type Add = (path: string, message: string) => void;

function personProblems(role: PersonRole, person: PersonForm, today: string, add: Add) {
  const at = (field: keyof PersonForm) => `${role}.${field}`;
  if (person.primaryIdentifier.trim() === '') {
    add(at('primaryIdentifier'), person.kind === 'legal' ? 'Give the legal name.' : 'Give the last name.');
  }
  if (hasAddress(person)) {
    if (person.city.trim() === '') add(at('city'), 'Give the city of the address.');
    if (!COUNTRY.test(upper(person.country))) add(at('country'), 'Two-letter ISO 3166-1 country code.');
  }
  if (person.countryOfResidence.trim() !== '' && !COUNTRY.test(upper(person.countryOfResidence))) {
    add(at('countryOfResidence'), 'Two-letter ISO 3166-1 country code.');
  }
  if (person.idType === '' && person.idValue.trim() !== '') add(at('idType'), 'Choose the identifier type.');
  if (person.idType !== '' && person.idValue.trim() === '') add(at('idValue'), 'Give the identifier.');
  if (person.idType === 'LEIX') {
    if (person.idValue.trim() !== '' && !isValidLei(upper(person.idValue))) {
      add(at('idValue'), 'Not a valid LEI (20 characters, ISO 17442 check digits).');
    }
    if (person.idCountry.trim() !== '') add(at('idCountry'), 'An LEI has no issuing country.');
  } else if (person.idCountry.trim() !== '' && !COUNTRY.test(upper(person.idCountry))) {
    add(at('idCountry'), 'Two-letter ISO 3166-1 country code.');
  }
  if (person.kind === 'natural') {
    const dob = person.dateOfBirth.trim();
    const place = person.placeOfBirth.trim();
    if (dob !== '') {
      const problem = birthDateProblem(dob, today);
      if (problem) add(at('dateOfBirth'), problem);
    }
    if (dob !== '' && place === '') add(at('placeOfBirth'), 'Give the place of birth with the date.');
    if (place !== '' && dob === '') add(at('dateOfBirth'), 'Give the date of birth with the place.');
  }
}

function vaspProblems(role: VaspRole, vasp: VaspForm, add: Add) {
  if (vasp.lei.trim() === '') return;
  if (vasp.name.trim() === '') add(`${role}.name`, 'Give the name of the VASP with its LEI.');
  if (!isValidLei(upper(vasp.lei))) add(`${role}.lei`, 'Not a valid LEI (20 characters, ISO 17442 check digits).');
}

export interface RecordContext {
  originatorAccount: PublicKey;
  beneficiaryAccount: PublicKey;
  amount: bigint;
  mint: PublicKey;
}

function person(form: PersonForm, account: PublicKey): TravelRulePerson {
  const natural = form.kind === 'natural';
  return {
    kind: form.kind,
    primaryIdentifier: form.primaryIdentifier.trim(),
    secondaryIdentifier: natural ? orNull(form.secondaryIdentifier) : null,
    accountNumber: account.toBase58(),
    address: hasAddress(form)
      ? {
          street: orNull(form.street),
          city: form.city.trim(),
          postcode: orNull(form.postcode),
          country: upper(form.country),
        }
      : null,
    nationalIdentification:
      form.idType === ''
        ? null
        : {
            type: form.idType,
            value: form.idType === 'LEIX' ? upper(form.idValue) : form.idValue.trim(),
            country: form.idType === 'LEIX' || form.idCountry.trim() === '' ? null : upper(form.idCountry),
          },
    dateOfBirth: natural ? orNull(form.dateOfBirth) : null,
    placeOfBirth: natural ? orNull(form.placeOfBirth) : null,
    countryOfResidence: form.countryOfResidence.trim() === '' ? null : upper(form.countryOfResidence),
  };
}

const vasp = (form: VaspForm): TravelRuleVasp | null =>
  form.name.trim() === '' ? null : { name: form.name.trim(), lei: form.lei.trim() === '' ? null : upper(form.lei) };

export type TravelRuleCheck = { ok: true; record: TravelRuleRecord } | { ok: false; errors: Record<string, string> };

const RECORD_PATH: Readonly<Record<string, string>> = {
  'address.street': 'street',
  'address.city': 'city',
  'address.postcode': 'postcode',
  'address.country': 'country',
  'nationalIdentification.type': 'idType',
  'nationalIdentification.value': 'idValue',
  'nationalIdentification.country': 'idCountry',
};

function formPath(path: readonly PropertyKey[]): string {
  const [head, ...rest] = path.map(String);
  const tail = rest.join('.');
  return `${head}.${RECORD_PATH[tail] ?? tail}`;
}

export function checkTravelRuleForm(form: TravelRuleForm, context: RecordContext, today: string): TravelRuleCheck {
  const errors: Record<string, string> = {};
  const add: Add = (path, message) => {
    errors[path] ??= message;
  };
  for (const role of PERSON_ROLES) personProblems(role, form[role], today, add);
  for (const role of VASP_ROLES) vaspProblems(role, form[role], add);
  const originator = form.originator;
  const identified =
    hasAddress(originator) ||
    originator.idType !== '' ||
    (originator.kind === 'natural' && originator.dateOfBirth.trim() !== '' && originator.placeOfBirth.trim() !== '');
  if (!identified) {
    add(
      'originator.identification',
      'Give the originator’s address, a national identifier or the date and place of birth.',
    );
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const parsed = TravelRuleRecordSchema.safeParse({
    originator: person(form.originator, context.originatorAccount),
    beneficiary: person(form.beneficiary, context.beneficiaryAccount),
    originatingVasp: vasp(form.originatingVasp),
    beneficiaryVasp: vasp(form.beneficiaryVasp),
    amount: context.amount.toString(),
    mint: context.mint.toBase58(),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) add(formPath(issue.path), issue.message);
    return { ok: false, errors };
  }
  return { ok: true, record: parsed.data };
}

export const travelRuleCommitment = (job: PublicKey, salt: Uint8Array, record: unknown): Uint8Array =>
  travelRule.commitment({ job, salt, record });

export const isBound = (commitment: Uint8Array) => commitment.some((byte) => byte !== 0);

export const travelRuleRequired = (amount: bigint, threshold: bigint) => threshold > 0n && amount >= threshold;

export type TravelRuleVerification =
  | { state: 'match'; storedAt: number; retainUntil: number }
  | { state: 'mismatch'; recomputed: string }
  | { state: 'missing'; reason: string };

export function verifyDisclosure(
  job: PublicKey,
  disclosure: TravelRuleDisclosure,
  chainCommitment: Uint8Array,
): TravelRuleVerification {
  const recomputed = bytesToHex(travelRuleCommitment(job, hexToBytes(disclosure.salt), disclosure.record));
  if (recomputed !== bytesToHex(chainCommitment)) return { state: 'mismatch', recomputed };
  return { state: 'match', storedAt: disclosure.status.storedAt, retainUntil: disclosure.status.retainUntil };
}

export type TravelRuleStatus = 'notRequired' | 'pending' | 'bound' | 'missing';

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

export function travelRuleFundBlock(params: {
  required: boolean;
  chainCommitment: Uint8Array;
  verification: TravelRuleVerification | null;
}): string | null {
  if (!params.required) return null;
  if (!isBound(params.chainCommitment)) {
    return 'Jobs of this size need a Travel Rule commitment before funding: store the originator and beneficiary record and bind its commitment.';
  }
  const verification = params.verification;
  if (!verification) {
    return 'Check the bound Travel Rule commitment against the record stored by the Square API before funding.';
  }
  if (verification.state === 'missing') {
    return `${verification.reason} Store the record and bind it again before funding.`;
  }
  if (verification.state === 'mismatch') {
    return 'The bound Travel Rule commitment does not match the record stored by the Square API. Store the record and bind it again before funding.';
  }
  return null;
}
