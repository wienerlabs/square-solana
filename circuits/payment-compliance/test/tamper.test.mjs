// Real Groth16 proofs: a proof verifies only for the exact thirteen public
// signals it was made for. Change any one of them, and verification fails.
//
// This is what makes the bindings in docs/design/release-circuit.md mean
// anything: the verifier fills the signals from the job, the claim, the policy
// snapshot and the counter, so a proof made for any other release does not
// verify against them.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { PUBLIC_SIGNALS, addressHalves, toArray, world } from '../scripts/release-input.mjs';
import { verifyPtau } from '../scripts/fetch-ptau.mjs';
import { BUILD, isBuilt, prerequisite, wasmPath } from './helpers/witness.mjs';
import { ensureTestKey } from './helpers/key.mjs';

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const INPUTS = path.resolve(BUILD, '..', 'test-inputs');

// The pinned PPoT file is fetched once (about 19 MB) by `npm run fetch-ptau`;
// without it these tests are skipped rather than downloading on their own.
const havePtau = (() => { try { verifyPtau(); return true; } catch { return false; } })();
const skip = prerequisite(
  (!isBuilt('payment') && 'run `npm run build` first') || (!havePtau && 'run `npm run fetch-ptau` first'),
);

const read = (f) => JSON.parse(fs.readFileSync(path.join(INPUTS, f), 'utf8'));
let vk;
const proofs = {};

async function prove(scenario) {
  const { zkey } = await ensureTestKey();
  return snarkjs.groth16.fullProve(read(`${scenario}.json`), wasmPath('payment'), zkey);
}

const verify = (signals, proof) => snarkjs.groth16.verify(vk, signals, proof);

before(async () => {
  if (skip) return;
  ({ vk } = await ensureTestKey());
  proofs.compliant = await prove('ok_compliant');
  proofs.refused = await prove('bad_payee_blocked');
});

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('a compliant proof verifies, with the recorded public signals', { skip }, async () => {
  const { proof, publicSignals } = proofs.compliant;
  assert.equal(vk.nPublic, PUBLIC_SIGNALS.length);
  assert.deepEqual(publicSignals, toArray(read('ok_compliant.expected.json').public_signals));
  assert.equal(await verify(publicSignals, proof), true);
});

test('a refusing proof is a valid proof too', { skip }, async () => {
  const { proof, publicSignals } = proofs.refused;
  assert.equal(publicSignals[0], '8');
  assert.equal(await verify(publicSignals, proof), true);
});

for (const [i, name] of PUBLIC_SIGNALS.entries()) {
  test(`changing ${name} (signal ${i}) breaks verification`, { skip }, async () => {
    const { proof, publicSignals } = proofs.compliant;
    const tampered = [...publicSignals];
    tampered[i] = String((BigInt(tampered[i]) + 1n) % R);
    assert.equal(await verify(tampered, proof), false);
  });
}

test('a refusal cannot be presented as compliance', { skip }, async () => {
  const { proof, publicSignals } = proofs.refused;
  assert.equal(await verify(['0', ...publicSignals.slice(1)], proof), false);
});

test('a proof for one job does not verify for another, nor for another payee', { skip }, async () => {
  const w = world();
  const { proof, publicSignals } = proofs.compliant;
  const [jobHigh, jobLow] = addressHalves(w.institution).map(String);
  const otherJob = [...publicSignals];
  otherJob[10] = jobHigh;
  otherJob[11] = jobLow;
  assert.equal(await verify(otherJob, proof), false);

  const [buyerHigh, buyerLow] = addressHalves(w.claimBuyer).map(String);
  const otherPayee = [...publicSignals];
  otherPayee[3] = buyerHigh;
  otherPayee[4] = buyerLow;
  assert.equal(await verify(otherPayee, proof), false);
});

test("a proof's own bytes are checked", { skip }, async () => {
  const { proof, publicSignals } = proofs.compliant;
  const other = proofs.refused.proof;
  assert.equal(await verify(publicSignals, { ...proof, pi_c: other.pi_c }), false);
});
