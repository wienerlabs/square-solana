// Compute a witness for a compiled circuit, in memory.
//
// snarkjs.wtns.calculate writes to a file and leaves a FileHandle open when a
// constraint fails, which is exactly the path the negative tests take; the
// witness calculator circom emits works in memory and throws instead.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const BUILD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'build');

const require = createRequire(import.meta.url);
const calculators = new Map();

export const wasmPath = (circuit) => path.join(BUILD, `${circuit}_js`, `${circuit}.wasm`);
export const isBuilt = (...circuits) => circuits.every((c) => fs.existsSync(wasmPath(c)));

async function calculator(circuit) {
  if (!calculators.has(circuit)) {
    const build = require(path.join(BUILD, `${circuit}_js`, 'witness_calculator.js'));
    calculators.set(circuit, await build(fs.readFileSync(wasmPath(circuit))));
  }
  return calculators.get(circuit);
}

// The witness as decimal strings; index 0 is the constant 1 and the outputs
// follow in declaration order. Throws when the input violates a constraint.
export async function calculateWitness(circuit, input) {
  const witness = await (await calculator(circuit)).calculateWitness(input, true);
  return witness.map((v) => v.toString());
}

// payment.circom's 13 public outputs.
export async function publicOutputs(input) {
  return (await calculateWitness('payment', input)).slice(1, 14);
}
