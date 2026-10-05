// Witnesses an honest prover would never write, and the constraints that refuse
// them. Each of these is a statement the circuit makes about its inputs rather
// than an assumption it leaves to the verifier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildInput } from '../scripts/release-input.mjs';
import { BUILD, calculateWitness, isBuilt, prerequisite } from './helpers/witness.mjs';

// BN254 scalar field modulus.
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const skipPayment = prerequisite(!isBuilt('payment') && 'run `npm run build` first');
const skipTimestamp = prerequisite(
  !isBuilt('timestamp_checked', 'timestamp_unchecked') && 'run `npm run build` first',
);

const rejects = (input, message) => assert.rejects(calculateWitness('payment', input), undefined, message);

// ---------------------------------------------------------------- range checks

test('every amount operand must fit in 64 bits', { skip: skipPayment }, async () => {
  const base = await buildInput();
  for (const field of ['net_amount_in', 'daily_spent_before_in', 'daily_ceiling_in', 'max_per_tx', 'max_daily']) {
    await assert.doesNotReject(calculateWitness('payment', { ...base, [field]: String((1n << 64n) - 1n) }), `${field} = 2^64 - 1`);
    await rejects({ ...base, [field]: String(1n << 64n) }, `${field} = 2^64`);
    await rejects({ ...base, [field]: String(R - 1n) }, `${field} = p - 1`);
  }
});

test('every address half must fit in 128 bits', { skip: skipPayment }, async () => {
  const base = await buildInput();
  for (const field of ['payee_high_in', 'payee_low_in', 'mint_high_in', 'mint_low_in', 'job_high_in', 'job_low_in']) {
    await rejects({ ...base, [field]: String(1n << 128n) }, `${field} = 2^128`);
  }
});

test('the lookup keys cannot be zero, so a padding slot never matches', { skip: skipPayment }, async () => {
  const base = await buildInput();
  await rejects({ ...base, payment_category: '0' }, 'payment_category = 0');
});

test('the list masks are gone: no input can switch a list off', { skip: skipPayment }, () => {
  // Aperture had token_whitelist_mask, blocked_addresses_mask and
  // allowed_categories_mask. time_days_bitmask is the window's weekday set and
  // is committed.
  const names = fs.readFileSync(path.join(BUILD, 'payment.sym'), 'utf8').split('\n').map((l) => l.split(',')[3]);
  const masks = names.filter((n) => /^main\.[a-z_]+_mask(\[\d+\])?$/.test(n ?? ''));
  assert.deepEqual(masks, []);
  assert.ok(names.includes('main.time_days_bitmask'));
});

test('time_active is boolean and the window fields are in range', { skip: skipPayment }, async () => {
  const base = await buildInput();
  await rejects({ ...base, time_active: '2' }, 'time_active = 2');
  await rejects({ ...base, time_start_hour_utc: '32' }, 'start hour 32');
  await rejects({ ...base, time_end_hour_utc: '32' }, 'end hour 32');
  await rejects({ ...base, time_days_bitmask: '128' }, 'day mask 128');
  const off = await buildInput({ timeActive: 0, timeDaysBitmask: 0, timeStartHourUtc: 0, timeEndHourUtc: 0 });
  await rejects({ ...off, time_days_bitmask: '128' }, 'day mask 128 with the window off');
});

test('the timestamp must fit in 40 bits', { skip: skipPayment }, async () => {
  const base = await buildInput();
  await rejects({ ...base, current_unix_timestamp_in: String(1n << 40n) }, 'timestamp = 2^40');
});

// ------------------------------------------------- forged weekday (control test)

function modInverse(a, m) {
  let [oldR, r] = [((a % m) + m) % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

// 2026-09-21T14:13:20Z, a Monday.
const TS = 1790000000n;

function honest(ts) {
  const day = ts / 86400n;
  const secInDay = ts % 86400n;
  return {
    timestamp: String(ts),
    day_index: String(day),
    sec_in_day: String(secInDay),
    hour: String(secInDay / 3600n),
    sec_in_hour: String(secInDay % 3600n),
    weeks: String((day + 3n) / 7n),
    day_of_week: String((day + 3n) % 7n),
  };
}

// Keep the timestamp, claim another weekday, and solve weeks in the field.
function forgeWeekday(ts, weekday) {
  const h = honest(ts);
  const weeks = ((BigInt(h.day_index) + 3n - BigInt(weekday)) * modInverse(7n, R)) % R;
  return { ...h, weeks: String(weeks), day_of_week: String(weekday) };
}

test('the Aperture decomposition accepts a forged weekday (control)', { skip: skipTimestamp }, async () => {
  assert.equal(honest(TS).day_of_week, '0');
  const witness = await calculateWitness('timestamp_unchecked', forgeWeekday(TS, 5));
  assert.equal(witness[2], '5', 'the old template reports Saturday for a Monday');
});

test('lib/timestamp.circom rejects a forged weekday for every other day', { skip: skipTimestamp }, async () => {
  await assert.doesNotReject(calculateWitness('timestamp_checked', honest(TS)));
  for (let d = 1; d < 7; d++) {
    await assert.rejects(calculateWitness('timestamp_checked', forgeWeekday(TS, d)), undefined, `weekday ${d}`);
  }
});

test('lib/timestamp.circom rejects a shifted day index and an hour past 23', { skip: skipTimestamp }, async () => {
  const h = honest(TS);
  const day = (R - 1n) / 2n;
  await assert.rejects(calculateWitness('timestamp_checked', {
    ...h,
    day_index: String(day),
    sec_in_day: String((((TS - day * 86400n) % R) + R) % R),
    weeks: String(((day + 3n - 0n) * modInverse(7n, R)) % R),
  }));
  await assert.rejects(calculateWitness('timestamp_checked', { ...h, hour: '25', sec_in_hour: '0' }));
});

test('lib/timestamp.circom agrees with the UTC calendar', { skip: skipTimestamp }, async () => {
  for (let i = 0n; i < 40n; i++) {
    const ts = 1767225600n + i * 9_123_457n;
    const input = honest(ts);
    const date = new Date(Number(ts) * 1000);
    assert.equal(input.day_of_week, String((date.getUTCDay() + 6) % 7));
    assert.equal(input.hour, String(date.getUTCHours()));
    const witness = await calculateWitness('timestamp_checked', input);
    assert.deepEqual(witness.slice(1, 3), [input.hour, input.day_of_week]);
  }
});
