#!/usr/bin/env node
// End-to-end sanity check for the Circom + groth16-solana pipeline.
//
// Usage:
//   1. Start prover-service in another terminal:
//      cd services/prover-service && PROVER_SERVICE_PORT=3099 npm run dev
//   2. Run this script:
//      node services/prover-service/scripts/integration-test.mjs
//
// What it validates:
//   - /prove endpoint returns a 200 for a known-compliant input fixture.
//   - proof_a / proof_b / proof_c decode to 64 / 128 / 64 byte buffers.
//   - public_inputs[0] encodes is_compliant canonically (zero or one).
//   - public_inputs[1] matches raw_public[1] (Poseidon journal digest).
//   - A bad fixture (amount over per-tx limit) still yields a verifiable
//     proof but with is_compliant = 0 — the circuit proves the check was
//     performed, not that the outcome was positive.

import assert from 'node:assert/strict';

const BASE_URL = process.env.PROVER_BASE_URL ?? 'http://localhost:3099';

function compliantInput() {
  return {
    max_daily_spend_lamports: 100000000,
    max_per_transaction_lamports: 10000000,
    allowed_endpoint_categories: ['compute', 'storage'],
    blocked_addresses: ['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'],
    token_whitelist: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    payment_amount_lamports: 5000000,
    payment_token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    payment_recipient: 'CBDjvUkZZ6ucrVGrU3vRraasTytha8oVg2NLCxAHE25b',
    payment_endpoint_category: 'compute',
    daily_spent_so_far_lamports: 50000000,
  };
}

function overLimitInput() {
  return {
    ...compliantInput(),
    payment_amount_lamports: 20000000, // > max_per_transaction_lamports
  };
}

async function callProve(payload) {
  const response = await fetch(`${BASE_URL}/prove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response.json();
}

function assertBufferLen(base64, expected, name) {
  const buf = Buffer.from(base64, 'base64');
  assert.equal(
    buf.length,
    expected,
    `${name}: expected ${expected} bytes, got ${buf.length}`,
  );
  return buf;
}

function assertIsCompliantEncoding(base64Value, expectedBool, name) {
  const buf = assertBufferLen(base64Value, 32, name);
  const expected = Buffer.alloc(32);
  if (expectedBool) expected[31] = 1;
  assert.deepEqual(
    buf,
    expected,
    `${name}: non-canonical encoding for is_compliant=${expectedBool}`,
  );
}

async function run() {
  console.log(`Using prover: ${BASE_URL}`);

  console.log('→ compliant case');
  const ok = await callProve(compliantInput());
  assert.equal(ok.is_compliant, true, 'compliant case should yield is_compliant=true');
  assertBufferLen(ok.groth16.proof_a, 64, 'proof_a');
  assertBufferLen(ok.groth16.proof_b, 128, 'proof_b');
  assertBufferLen(ok.groth16.proof_c, 64, 'proof_c');
  assert.equal(ok.groth16.public_inputs.length, 2, 'public_inputs count');
  assertIsCompliantEncoding(ok.groth16.public_inputs[0], true, 'public_inputs[0]');
  const journalBytes = assertBufferLen(
    ok.groth16.public_inputs[1],
    32,
    'public_inputs[1]',
  );
  const rawDigest = BigInt(ok.raw_public[1]);
  const encodedDigest = BigInt('0x' + journalBytes.toString('hex'));
  assert.equal(
    rawDigest,
    encodedDigest,
    'public_inputs[1] must equal raw_public[1] as a field element',
  );
  console.log(`  ok — ${ok.proving_time_ms} ms`);

  console.log('→ over-limit case');
  const bad = await callProve(overLimitInput());
  assert.equal(bad.is_compliant, false, 'over-limit case should yield is_compliant=false');
  assertIsCompliantEncoding(bad.groth16.public_inputs[0], false, 'public_inputs[0]');
  console.log(`  ok — ${bad.proving_time_ms} ms`);

  console.log('All assertions passed.');
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
