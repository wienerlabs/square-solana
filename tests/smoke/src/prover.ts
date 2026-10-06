// İn-process prover: release devresinin wasm'ı ve zkey'i (circuits/payment-compliance) ile
// `createLocalProver` (@squaresdk/solana-policy). İkisinin SHA-256'sı devrenin manifest'iyle karşılaştırılır
// (prover servisi ile aynı kural, BE-11); uymazsa zincir ispatı reddedeceği için koşu başlamaz. wasm
// depoya girmez, devreden derlenir: `CIRCOM=<circom 2.2.3> node scripts/build.mjs` (devrenin README'si).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2';
import { createLocalProver, type Groth16Backend, type Prover } from '@squaresdk/solana-policy';
import { groth16 } from 'snarkjs';
import { REPO_ROOT } from './keys.js';

const hex = (bytes: Uint8Array) => Buffer.from(sha256(bytes)).toString('hex');

export interface CircuitArtifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
  /** zkey'in SHA-256'sı (ispatların `artifactVersion`'ı). */
  version: string;
}

export function loadCircuitArtifacts(
  circuitDir: string = join(REPO_ROOT, 'circuits/payment-compliance'),
): CircuitArtifacts {
  const wasmPath = join(circuitDir, 'build/payment_js/payment.wasm');
  if (!existsSync(wasmPath)) {
    throw new Error(
      `devre derlenmemiş: ${wasmPath} yok. circuits/payment-compliance altında ` +
        '`npm ci && CIRCOM=<circom 2.2.3> node scripts/build.mjs` (ya da scripts/ci-build.sh)',
    );
  }
  const manifest = JSON.parse(readFileSync(join(circuitDir, 'artifacts/manifest.json'), 'utf8')) as {
    wasm: { sha256: string };
    zkey: { sha256: string };
  };
  const wasm = new Uint8Array(readFileSync(wasmPath));
  const zkey = new Uint8Array(readFileSync(join(circuitDir, 'artifacts/payment.zkey')));
  if (hex(wasm) !== manifest.wasm.sha256) {
    throw new Error(`wasm manifest'le uyuşmuyor: ${hex(wasm)} ≠ ${manifest.wasm.sha256} (circom 2.2.3 ile derleyin)`);
  }
  const version = hex(zkey);
  if (version !== manifest.zkey.sha256)
    throw new Error(`zkey manifest'le uyuşmuyor: ${version} ≠ ${manifest.zkey.sha256}`);
  return { wasm, zkey, version };
}

export function localProver(artifacts: CircuitArtifacts): Prover {
  return createLocalProver({
    wasm: artifacts.wasm,
    zkey: artifacts.zkey,
    groth16: groth16 as unknown as Groth16Backend,
  });
}

/** snarkjs'in BN254 işçi havuzu açık kalırsa süreç bitmez. */
export async function releaseProverWorkers(): Promise<void> {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
}
