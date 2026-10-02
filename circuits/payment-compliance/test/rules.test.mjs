// The circuit agrees with the circuit-independent evaluation
// (scripts/release-input.mjs#evaluate) well beyond the fixed scenarios, and the
// policy commitment binds exactly the policy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  NATIVE_MINT, TIMESTAMP, USDC_DEVNET, buildInput, evaluate, toArray, world,
} from '../scripts/release-input.mjs';
import { isBuilt, publicOutputs } from './helpers/witness.mjs';

const skip = !isBuilt('payment') && 'run `npm run build` first';

// Deterministic, so a failure names a case that can be rerun.
function prng(seed) {
  let counter = 0;
  return (n) => {
    const h = crypto.createHash('sha256').update(`${seed}/${counter++}`).digest();
    return Number(h.readBigUInt64BE(0) % BigInt(n));
  };
}

test('60 generated releases: every public signal matches the independent evaluation', { skip }, async () => {
  const w = world();
  const pick = prng('bc-19 rules');
  const USDC = 1_000_000n;
  for (let i = 0; i < 60; i++) {
    const start = pick(24);
    const overrides = {
      maxPerTx: BigInt(pick(200) + 1) * USDC,
      maxDaily: BigInt(pick(1000) + 1) * USDC,
      dailyCeiling: BigInt(pick(1200)) * USDC,
      netAmount: BigInt(pick(250)) * USDC + BigInt(pick(1000)),
      dailySpentBefore: BigInt(pick(900)) * USDC,
      payee: [w.agentWallet, w.claimBuyer, w.blockedWallet][pick(3)],
      mint: [USDC_DEVNET, NATIVE_MINT][pick(2)],
      paymentCategory: ['research', 'data', 'gambling'][pick(3)],
      timeActive: pick(2),
      timeDaysBitmask: pick(128),
      timeStartHourUtc: start,
      timeEndHourUtc: start + pick(24 - start),
      timestamp: 1767225600 + pick(366 * 86400), // during 2026
    };
    const input = await buildInput(overrides);
    assert.deepEqual(await publicOutputs(input), toArray(await evaluate(input)), `case ${i}: ${JSON.stringify(overrides, (k, v) => (typeof v === 'bigint' ? String(v) : v))}`);
  }
});

test('the weekday and hour the circuit uses are UTC calendar ones', { skip }, async () => {
  // A window of one weekday and one hour, swept across a week hour by hour.
  for (let weekday = 0; weekday < 7; weekday++) {
    const ts = TIMESTAMP + weekday * 86400; // TIMESTAMP is a Monday, 14:13:20
    const date = new Date(ts * 1000);
    assert.equal((date.getUTCDay() + 6) % 7, weekday);
    const input = await buildInput({ timestamp: ts, timeDaysBitmask: 1 << weekday, timeStartHourUtc: 14, timeEndHourUtc: 14 });
    assert.equal((await publicOutputs(input))[0], '0', `weekday ${weekday} inside its own window`);
    const other = await buildInput({ timestamp: ts, timeDaysBitmask: 1 << ((weekday + 1) % 7), timeStartHourUtc: 14, timeEndHourUtc: 14 });
    assert.equal((await publicOutputs(other))[0], '32', `weekday ${weekday} outside the next day's window`);
  }
});

test('the commitment changes with every committed field and every salt', { skip }, async () => {
  const base = await buildInput();
  const [baseCommitment] = (await publicOutputs(base)).slice(1, 2);
  const variants = {
    max_per_tx: { maxPerTx: 100_000_001n },
    max_daily: { maxDaily: 500_000_001n },
    token_whitelist: { tokenWhitelist: [USDC_DEVNET, NATIVE_MINT] },
    blocked_addresses: { blockedAddresses: [] },
    allowed_categories: { allowedCategories: ['research'] },
    time_window: { timeEndHourUtc: 16 },
    time_off: { timeActive: 0 },
  };
  const seen = new Set([baseCommitment]);
  for (const [field, overrides] of Object.entries(variants)) {
    const c = (await publicOutputs(await buildInput(overrides)))[1];
    assert.ok(!seen.has(c), `${field} does not move the commitment`);
    seen.add(c);
  }
  for (let i = 0; i < 8; i++) {
    const salts = [...base.policy_salts];
    salts[i] = (BigInt(salts[i]) + 1n).toString();
    const c = (await publicOutputs({ ...base, policy_salts: salts }))[1];
    assert.ok(!seen.has(c), `salt ${i} does not move the commitment`);
    seen.add(c);
  }
});

test('the commitment does not depend on the release', { skip }, async () => {
  const w = world();
  const a = await publicOutputs(await buildInput());
  const b = await publicOutputs(await buildInput({
    payee: w.claimBuyer, netAmount: 1n, dailySpentBefore: 0n, timestamp: TIMESTAMP + 86400, job: w.claimBuyer, dailyCeiling: 7n,
  }));
  assert.equal(a[1], b[1]);
});

test('a time window that is off ignores the clock', { skip }, async () => {
  for (const hour of [0, 6, 20, 23]) {
    const input = await buildInput({ timeActive: 0, timeDaysBitmask: 0, timeStartHourUtc: 0, timeEndHourUtc: 0, timestamp: TIMESTAMP - 14 * 3600 + hour * 3600 + 5 * 86400 });
    assert.equal((await publicOutputs(input))[0], '0');
  }
});
