// Release anahtarı (BC-20): depodaki zkey ve doğrulama anahtarı; wasm devreden derlenir
// (`node circuits/payment-compliance/scripts/build.mjs`, CI'da packages.yml).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';
import type { ProveResponse } from '@squaresdk/solana-types';
import { createLocalProver } from '../../src/prover.js';
import { CIRCUIT_DIR, readCircuitJson } from './circuit-world.js';

const WASM = new URL('build/payment_js/payment.wasm', CIRCUIT_DIR);
if (!existsSync(WASM)) {
  throw new Error(`devre derlenmemiş: ${fileURLToPath(WASM)} yok (node circuits/payment-compliance/scripts/build.mjs)`);
}

export const manifest = readCircuitJson('artifacts/manifest.json');
export const verificationKey = readCircuitJson('artifacts/verification_key.json');
export const zkey = new Uint8Array(readFileSync(new URL('artifacts/payment.zkey', CIRCUIT_DIR)));
export const wasm = new Uint8Array(readFileSync(WASM));
export const localProver = createLocalProver({ wasm, zkey, groth16 });

const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const words = (hex: string) => (hex.match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`).toString());

/** ProveResponse (groth16-solana düzeni) → snarkjs ispatı ve sinyalleri, doğrulama için. */
export function toSnarkjs(response: ProveResponse) {
  const [ax, ayNeg] = words(response.proofA);
  const [bx1, bx0, by1, by0] = words(response.proofB);
  const [cx, cy] = words(response.proofC);
  return {
    proof: {
      pi_a: [ax!, ((Q - BigInt(ayNeg!)) % Q).toString(), '1'],
      pi_b: [
        [bx0!, bx1!],
        [by0!, by1!],
        ['1', '0'],
      ],
      pi_c: [cx!, cy!, '1'],
      protocol: 'groth16',
      curve: 'bn128',
    },
    publicSignals: response.publicInputs.map((h) => BigInt(`0x${h}`).toString()),
  };
}

export const verify = (response: ProveResponse) => {
  const { proof, publicSignals } = toSnarkjs(response);
  return groth16.verify(verificationKey, publicSignals, proof);
};
