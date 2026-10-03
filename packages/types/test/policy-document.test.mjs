import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as t from '../dist/index.js';

// Fixture adresleri: IDL'lerdeki kaynak program kimlikleri (geçerli base58 adresler).
const A = 'CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc';
const B = 'FXD7ycSguBQw7o3DXqq4VUBHtdx5ZQpu9P2zb4KG4ZEU';
const C = 'AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU';

const base = () => ({
  institution: A,
  policyId: 'cd'.repeat(32),
  version: 1,
  dailyCeiling: '5000000000',
  maxDaily: '4000000000',
  maxPerTx: '1000000000',
  tokenWhitelist: [B],
  blockedPayees: [C],
  allowedCategories: ['compute', 'çeviri'],
  timeWindow: { days: ['monday', 'friday'], startHourUtc: 9, endHourUtc: 17 },
});

const parse = (overrides) => t.PolicyDocumentSchema.safeParse({ ...base(), ...overrides });

test('PolicyDocument: devrenin kabul ettiği politika geçer', () => {
  const result = parse({});
  assert.ok(result.success, JSON.stringify(result.error?.issues));
  assert.ok(parse({ timeWindow: null }).success);
  assert.ok(parse({ blockedPayees: [] }).success);
});

test('PolicyDocument: liste boyları devrenin yuvalarını aşamaz', () => {
  const addresses = (n) => Array.from({ length: n }, (_, i) => `${'1'.repeat(31)}${'23456789ABCDEFGHJKLMNP'[i]}`);
  assert.ok(parse({ tokenWhitelist: addresses(10) }).success);
  assert.ok(!parse({ tokenWhitelist: addresses(11) }).success);
  assert.ok(!parse({ blockedPayees: addresses(11) }).success);
  assert.ok(parse({ allowedCategories: Array.from({ length: 8 }, (_, i) => `c${i}`) }).success);
  assert.ok(!parse({ allowedCategories: Array.from({ length: 9 }, (_, i) => `c${i}`) }).success);
});

test('PolicyDocument: boş whitelist / kategori, tekrar ve 32 baytı aşan kategori reddedilir', () => {
  assert.ok(!parse({ tokenWhitelist: [] }).success);
  assert.ok(!parse({ allowedCategories: [] }).success);
  assert.ok(!parse({ tokenWhitelist: [B, B] }).success);
  assert.ok(!parse({ allowedCategories: ['a', 'a'] }).success);
  assert.ok(parse({ allowedCategories: ['x'.repeat(32)] }).success);
  assert.ok(!parse({ allowedCategories: ['x'.repeat(33)] }).success);
  // 'ç' iki bayt: 16 karakter = 32 bayt geçer, 17 karakter = 34 bayt geçmez.
  assert.ok(parse({ allowedCategories: ['ç'.repeat(16)] }).success);
  assert.ok(!parse({ allowedCategories: ['ç'.repeat(17)] }).success);
});

test('PolicyDocument: pencere UTC, gece yarısını geçemez, gün adları tekil', () => {
  assert.ok(parse({ timeWindow: { days: ['sunday'], startHourUtc: 0, endHourUtc: 23 } }).success);
  assert.ok(parse({ timeWindow: { days: ['monday'], startHourUtc: 12, endHourUtc: 12 } }).success);
  assert.ok(!parse({ timeWindow: { days: ['monday'], startHourUtc: 22, endHourUtc: 2 } }).success);
  assert.ok(!parse({ timeWindow: { days: ['monday'], startHourUtc: 9, endHourUtc: 24 } }).success);
  assert.ok(!parse({ timeWindow: { days: ['monday', 'monday'], startHourUtc: 9, endHourUtc: 17 } }).success);
  assert.ok(!parse({ timeWindow: { days: [], startHourUtc: 9, endHourUtc: 17 } }).success);
  assert.ok(!parse({ timeWindow: { days: [0], startHourUtc: 9, endHourUtc: 17 } }).success);
});

test('PolicyDocument: sınırlar devre kaynağıyla aynı', () => {
  const circom = readFileSync(
    fileURLToPath(new URL('../../../circuits/payment-compliance/payment.circom', import.meta.url)),
    'utf8',
  );
  const match = circom.match(/component main[^=]*= ReleaseCompliance\((\d+), (\d+), (\d+)\);/);
  assert.ok(match, 'payment.circom ana bileşeni bulunamadı');
  assert.deepEqual(
    [Number(match[1]), Number(match[2]), Number(match[3])],
    [
      t.POLICY_CIRCUIT_LIMITS.tokenWhitelist,
      t.POLICY_CIRCUIT_LIMITS.blockedPayees,
      t.POLICY_CIRCUIT_LIMITS.allowedCategories,
    ],
  );
  assert.equal(t.DAYS_OF_WEEK[0], 'monday', 'devrenin gün maskesinde Pazartesi 0. bittir');
});
