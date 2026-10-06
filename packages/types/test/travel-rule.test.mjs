import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = '5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT';

const natural = {
  kind: 'natural',
  primaryIdentifier: 'Yılmaz',
  secondaryIdentifier: 'Deniz',
  accountNumber: WALLET,
  address: { street: 'Atatürk Cad. 12', city: 'İzmir', postcode: '35210', country: 'TR' },
  nationalIdentification: { type: 'CCPT', value: 'U12345678', country: 'TR' },
  dateOfBirth: '1990-04-12',
  placeOfBirth: 'İzmir',
  countryOfResidence: 'TR',
};
const legal = {
  kind: 'legal',
  primaryIdentifier: 'Example Research Ltd',
  secondaryIdentifier: null,
  accountNumber: WALLET,
  address: null,
  nationalIdentification: { type: 'LEIX', value: '5493001KJTIIGC8Y1R12', country: null },
  dateOfBirth: null,
  placeOfBirth: null,
  countryOfResidence: 'GB',
};
const record = {
  originator: legal,
  beneficiary: natural,
  originatingVasp: { name: 'Example Custody AG', lei: '5493001KJTIIGC8Y1R12' },
  beneficiaryVasp: null,
  amount: '2500000000',
  mint: MINT,
};

test('TravelRuleRecord: gerçek ve tüzel kişi, VASP', () => {
  assert.deepEqual(t.TravelRuleRecordSchema.parse(record), record);
});

test('TravelRuleRecord: değerler kırpılır; tanınmayan alan reddedilir (commitment girdisi sessizce değişmesin)', () => {
  const parsed = t.TravelRuleRecordSchema.parse({
    ...record,
    beneficiary: { ...natural, primaryIdentifier: ' Yılmaz ' },
  });
  assert.equal(parsed.beneficiary.primaryIdentifier, 'Yılmaz');
  assert.ok(!t.TravelRuleRecordSchema.safeParse({ ...record, note: 'x' }).success);
  assert.ok(!t.TravelRuleRecordSchema.safeParse({ ...record, beneficiary: { ...natural, email: 'x' } }).success);
});

test('TravelRulePerson: tüzel kişide ad, doğum tarihi ve yeri null olmalı', () => {
  const result = t.TravelRulePersonSchema.safeParse({ ...legal, dateOfBirth: '1990-01-01', placeOfBirth: 'Londra' });
  assert.ok(!result.success);
  assert.deepEqual(result.error.issues.map((issue) => issue.path.join('.')).sort(), ['dateOfBirth', 'placeOfBirth']);
});

test('TravelRulePerson: ülke kodu, tarih ve kimlik türü biçimi', () => {
  assert.ok(!t.TravelRulePersonSchema.safeParse({ ...natural, countryOfResidence: 'tr' }).success);
  assert.ok(!t.TravelRulePersonSchema.safeParse({ ...natural, dateOfBirth: '12.04.1990' }).success);
  assert.ok(
    !t.TravelRulePersonSchema.safeParse({
      ...natural,
      nationalIdentification: { type: 'PASS', value: 'x', country: null },
    }).success,
  );
  assert.ok(!t.TravelRuleVaspSchema.safeParse({ name: 'x', lei: '123' }).success);
});

test('TravelRuleGrantCreate ve erişim eylemleri', () => {
  assert.ok(
    t.TravelRuleGrantCreateSchema.safeParse({ grantee: WALLET, purpose: 'karşı VASP', expiresAt: 1_790_000_000 })
      .success,
  );
  assert.ok(!t.TravelRuleGrantCreateSchema.safeParse({ grantee: WALLET, purpose: '', expiresAt: 1 }).success);
  assert.deepEqual(t.TravelRuleAccessActionSchema.options, ['store', 'read', 'grant', 'revoke', 'purge']);
});
