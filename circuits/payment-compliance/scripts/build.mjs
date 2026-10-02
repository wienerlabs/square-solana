#!/usr/bin/env node
// Compile payment.circom and the two timestamp test circuits into build/, and
// print the release circuit's constraint count.
//
// circom is taken from $CIRCOM, else from PATH. Verified with circom 2.2.3; the
// counts in docs/design/release-circuit.md are that compiler's at its default
// optimisation level, and test/constraints.test.mjs holds the build to them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const CIRCOM = process.env.CIRCOM || 'circom';

const CIRCUITS = [
  'payment.circom',
  'test/circuits/timestamp_checked.circom',
  'test/circuits/timestamp_unchecked.circom',
];

fs.mkdirSync(BUILD, { recursive: true });

const version = spawnSync(CIRCOM, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  process.stderr.write(`error: ${CIRCOM} not found; install circom 2.2.3 or set CIRCOM\n`);
  process.exit(1);
}
process.stdout.write(version.stdout);

for (const circuit of CIRCUITS) {
  const result = spawnSync(
    CIRCOM,
    [circuit, '--r1cs', '--wasm', '--sym', '-l', 'node_modules', '-o', BUILD],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    process.exit(result.status ?? 1);
  }
  process.stdout.write(`compiled ${circuit}\n`);
}

const info = await snarkjs.r1cs.info(path.join(BUILD, 'payment.r1cs'));
const power = Math.floor(Math.log2(info.nConstraints + info.nPubInputs + info.nOutputs)) + 1;
process.stdout.write(
  `payment.circom: ${info.nConstraints} constraints, ${info.nOutputs} public outputs, `
  + `${info.nPrvInputs} private inputs, ${info.nVars} wires; needs powers of tau 2^${power}\n`,
);
if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
