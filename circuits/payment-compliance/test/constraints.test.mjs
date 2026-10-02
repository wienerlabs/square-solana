// The constraint count docs/design/release-circuit.md states is the one the
// build has, and the public outputs are declared in the order the verifier
// reads them.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as snarkjs from 'snarkjs';
import { PUBLIC_SIGNALS } from '../scripts/release-input.mjs';
import { BUILD, isBuilt } from './helpers/witness.mjs';

const skip = !isBuilt('payment') && 'run `npm run build` first';
const DOC = path.resolve(BUILD, '..', '..', '..', 'docs', 'design', 'release-circuit.md');

// circom 2.2.3, default optimisation: 6 228 non-linear + 7 267 linear.
const CONSTRAINTS = 13495;
const PRIVATE_INPUTS = 56;
const POWER = 14;

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test('payment.r1cs has the documented size and fits the pinned powers of tau', { skip }, async () => {
  const info = await snarkjs.r1cs.info(path.join(BUILD, 'payment.r1cs'));
  assert.equal(info.nConstraints, CONSTRAINTS);
  assert.equal(info.nOutputs, PUBLIC_SIGNALS.length);
  assert.equal(info.nPubInputs, 0);
  assert.equal(info.nPrvInputs, PRIVATE_INPUTS);
  // snarkjs: power = floor(log2(constraints + public)) + 1
  assert.equal(Math.floor(Math.log2(info.nConstraints + info.nOutputs)) + 1, POWER);
});

test('the design document states the same numbers', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const figure of ['13 495', '6 228', '7 267', '2^14']) {
    assert.ok(doc.includes(figure), `release-circuit.md does not mention ${figure}`);
  }
});

test('public outputs are declared in PUBLIC_SIGNALS order', { skip }, () => {
  // payment.sym: label, witness index, component, name. Witness 1..13 are the outputs.
  const byIndex = new Map();
  for (const line of fs.readFileSync(path.join(BUILD, 'payment.sym'), 'utf8').split('\n')) {
    const [, witness, , name] = line.split(',');
    if (name?.startsWith('main.') && !name.slice(5).includes('.')) byIndex.set(Number(witness), name.slice(5));
  }
  assert.deepEqual(PUBLIC_SIGNALS.map((_, i) => byIndex.get(i + 1)), [...PUBLIC_SIGNALS]);
});
