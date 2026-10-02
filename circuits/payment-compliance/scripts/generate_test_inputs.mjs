#!/usr/bin/env node
// Write the release scenarios to test-inputs/: for each, the circuit input
// (<name>.json, usable with `snarkjs wtns calculate`) and the public signals an
// honest witness must produce (<name>.expected.json).
//
// Expected values come from scripts/release-input.mjs#evaluate, the circuit-
// independent implementation, and every scenario states the refusal code it is
// meant to produce, so a scenario that drifts from its purpose fails here
// before it reaches a test.
//
//   node scripts/generate_test_inputs.mjs           write test-inputs/
//   node scripts/generate_test_inputs.mjs --check   fail if test-inputs/ is stale

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_MINT, REFUSAL, TIMESTAMP, buildInput, evaluate, refusalNames, world,
} from './release-input.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-inputs');

const USDC = 1_000_000n;
const HOUR = 3600;
const DAY = 86400;

// The default release (scripts/release-input.mjs#buildInput): 25 USDC to the
// agent wallet in devnet USDC, 200 USDC already spent today, private ceilings
// 100 per release and 500 per day, public ceiling 1000, category "research",
// window Monday-Friday 09:00-17:59 UTC, Monday 14:13:20 UTC.
export function scenarios() {
  const w = world();
  return [
    {
      name: 'ok_compliant',
      description: 'Every rule passes; the time window is active and the release is inside it.',
      overrides: {},
      refusal: 0,
    },
    {
      name: 'ok_no_time_window',
      description: 'No time window (time_active = 0): a release at 20:13 on a Monday passes.',
      overrides: { timeActive: 0, timeDaysBitmask: 0, timeStartHourUtc: 0, timeEndHourUtc: 0, timestamp: TIMESTAMP + 6 * HOUR },
      refusal: 0,
    },
    {
      name: 'ok_at_every_limit',
      description: 'Each comparison at its boundary: net = max_per_tx, spent + net = max_daily = daily_ceiling, hour = window end (17).',
      overrides: { netAmount: 100n * USDC, dailySpentBefore: 400n * USDC, dailyCeiling: 500n * USDC, timestamp: TIMESTAMP + 3 * HOUR + 46 * 60 + 39 },
      refusal: 0,
    },
    {
      name: 'ok_sold_claim',
      description: 'The receivable was sold: the payee is the claim buyer, not the agent wallet.',
      overrides: { payee: w.claimBuyer },
      refusal: 0,
    },
    {
      name: 'bad_per_tx',
      description: 'net = max_per_tx + 1 base unit.',
      overrides: { netAmount: 100n * USDC + 1n },
      refusal: REFUSAL.PER_TX,
    },
    {
      name: 'bad_daily_private',
      description: 'spent + net = 505 USDC: over the private 500, under the public 1000.',
      overrides: { dailySpentBefore: 480n * USDC },
      refusal: REFUSAL.DAILY_PRIVATE,
    },
    {
      name: 'bad_mint_not_whitelisted',
      description: 'Settles in the native SOL mint, which is not on the whitelist.',
      overrides: { mint: NATIVE_MINT },
      refusal: REFUSAL.MINT_NOT_ALLOWED,
    },
    {
      name: 'bad_payee_blocked',
      description: 'The payee is on the blocked list.',
      overrides: { payee: w.blockedWallet },
      refusal: REFUSAL.PAYEE_BLOCKED,
    },
    {
      name: 'bad_category',
      description: 'Payment category "gambling" is not allowed.',
      overrides: { paymentCategory: 'gambling' },
      refusal: REFUSAL.CATEGORY_NOT_ALLOWED,
    },
    {
      name: 'bad_time_window_day',
      description: 'Saturday 14:13 UTC: the right hour on a day outside the window.',
      overrides: { timestamp: TIMESTAMP + 5 * DAY },
      refusal: REFUSAL.OUTSIDE_TIME_WINDOW,
    },
    {
      name: 'bad_time_window_hour',
      description: 'Monday 18:00:00 UTC: one second past the last hour of the window.',
      overrides: { timestamp: TIMESTAMP + 3 * HOUR + 46 * 60 + 40 },
      refusal: REFUSAL.OUTSIDE_TIME_WINDOW,
    },
    {
      name: 'bad_daily_ceiling',
      description: 'spent + net = 225 USDC: under the private 2000, over the public 220.',
      overrides: { maxDaily: 2000n * USDC, dailyCeiling: 220n * USDC },
      refusal: REFUSAL.DAILY_CEILING,
    },
    {
      name: 'bad_zero_ceiling',
      description: 'A public ceiling of 0 authorises no spending (fail closed).',
      overrides: { dailyCeiling: 0n },
      refusal: REFUSAL.DAILY_CEILING,
    },
    {
      name: 'bad_several_rules',
      description: '150 USDC at 20:13 with 900 already spent: per-transaction, both daily ceilings and the window, all reported.',
      overrides: { netAmount: 150n * USDC, dailySpentBefore: 900n * USDC, timestamp: TIMESTAMP + 6 * HOUR },
      refusal: REFUSAL.PER_TX | REFUSAL.DAILY_PRIVATE | REFUSAL.OUTSIDE_TIME_WINDOW | REFUSAL.DAILY_CEILING,
    },
  ];
}

export async function render() {
  const files = new Map();
  for (const s of scenarios()) {
    const input = await buildInput(s.overrides);
    const expected = await evaluate(input);
    if (Number(expected.refusal_code) !== s.refusal) {
      throw new Error(`${s.name}: evaluates to refusal ${expected.refusal_code}, the scenario says ${s.refusal}`);
    }
    files.set(`${s.name}.json`, `${JSON.stringify(input, null, 2)}\n`);
    files.set(`${s.name}.expected.json`, `${JSON.stringify({
      description: s.description,
      refusal_code: expected.refusal_code,
      refused_rules: refusalNames(expected.refusal_code),
      public_signals: expected,
    }, null, 2)}\n`);
  }
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await render();
  const onDisk = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.endsWith('.json')) : [];
  if (process.argv.includes('--check')) {
    const stale = [...files].filter(([f, body]) => !fs.existsSync(path.join(OUT, f)) || fs.readFileSync(path.join(OUT, f), 'utf8') !== body).map(([f]) => f);
    const extra = onDisk.filter((f) => !files.has(f));
    if (stale.length || extra.length) {
      process.stderr.write(`test-inputs/ is stale: ${[...stale, ...extra.map((f) => `${f} (not generated)`)].join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`test-inputs/ is current (${files.size / 2} scenarios)\n`);
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    for (const f of onDisk) if (!files.has(f)) fs.rmSync(path.join(OUT, f));
    for (const [f, body] of files) fs.writeFileSync(path.join(OUT, f), body);
    process.stdout.write(`wrote ${files.size / 2} scenarios to ${path.relative(process.cwd(), OUT)}\n`);
  }
}
