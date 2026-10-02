// Every scenario in test-inputs/ produces the public signals it records, and
// test-inputs/ is what the generator writes today.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { render, scenarios } from '../scripts/generate_test_inputs.mjs';
import { toArray } from '../scripts/release-input.mjs';
import { BUILD, isBuilt, publicOutputs } from './helpers/witness.mjs';

const DIR = path.resolve(BUILD, '..', 'test-inputs');
const skip = !isBuilt('payment') && 'run `npm run build` first';
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

test('test-inputs/ matches the generator', async () => {
  const files = await render();
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(onDisk, [...files.keys()].sort());
  for (const [f, body] of files) {
    assert.equal(fs.readFileSync(path.join(DIR, f), 'utf8'), body, `${f} is stale: run npm run inputs`);
  }
});

test('there is an ok and a bad scenario for every rule', () => {
  const codes = scenarios().map((s) => s.refusal);
  assert.ok(codes.includes(0));
  for (let bit = 0; bit < 7; bit++) {
    assert.ok(codes.includes(1 << bit), `no scenario breaks only rule bit ${bit}`);
  }
});

for (const s of scenarios()) {
  test(`${s.name}: refusal ${s.refusal}, public signals as recorded`, { skip }, async () => {
    const expected = read(`${s.name}.expected.json`);
    const outputs = await publicOutputs(read(`${s.name}.json`));
    assert.equal(outputs[0], String(s.refusal));
    assert.deepEqual(outputs, toArray(expected.public_signals));
  });
}
