// Release devresinin gerçek artefaktları: depodaki zkey ve manifest (BC-20), devreden derlenen wasm
// (`circuits/payment-compliance/scripts/build.mjs`; CI'da `ci-build.sh`). Witness'lar devrenin
// test-inputs/ senaryolarıdır (release-input.mjs'ten üretilir).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';
import type { ProveResponse } from '@squaresdk/solana-types';
import type { ArtifactPaths } from '../src/config.js';

export const CIRCUIT_DIR = new URL('../../../circuits/payment-compliance/', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, CIRCUIT_DIR));

export const ARTIFACT_PATHS: ArtifactPaths = Object.freeze({
  manifestPath: path('artifacts/manifest.json'),
  wasmPath: path('build/payment_js/payment.wasm'),
  zkeyPath: path('artifacts/payment.zkey'),
});
if (!existsSync(ARTIFACT_PATHS.wasmPath)) {
  throw new Error(
    `devre derlenmemiş: ${ARTIFACT_PATHS.wasmPath} yok (node circuits/payment-compliance/scripts/build.mjs)`,
  );
}

const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
export const MANIFEST = readJson(ARTIFACT_PATHS.manifestPath);
export const VERIFICATION_KEY = readJson(path('artifacts/verification_key.json'));

export interface Scenario {
  name: string;
  witness: Record<string, string | string[]>;
  /** Devrenin 13 public sinyali, devre sırasıyla (ondalık). */
  publicSignals: string[];
}

export const SCENARIOS: readonly Scenario[] = readdirSync(path('test-inputs'))
  .filter((file) => file.endsWith('.json') && !file.endsWith('.expected.json'))
  .map((file) => {
    const name = file.replace(/\.json$/, '');
    const expected = readJson(path(`test-inputs/${name}.expected.json`));
    return {
      name,
      witness: readJson(path(`test-inputs/${file}`)),
      publicSignals: Object.values(expected.public_signals as Record<string, string>),
    };
  });

export const scenario = (name: string): Scenario => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (!found) throw new Error(`senaryo yok: ${name}`);
  return found;
};

const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const words = (hex: string) => (hex.match(/.{64}/g) ?? []).map((w) => BigInt(`0x${w}`).toString());

/** ProveResponse (groth16-solana düzeni) → snarkjs ispatı ve sinyalleri. */
export function toSnarkjs(response: Pick<ProveResponse, 'proofA' | 'proofB' | 'proofC' | 'publicInputs'>) {
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

/** Release doğrulama anahtarıyla (depodaki verification_key.json) bağımsız doğrulama. */
export const verifyResponse = (response: Pick<ProveResponse, 'proofA' | 'proofB' | 'proofC' | 'publicInputs'>) => {
  const { proof, publicSignals } = toSnarkjs(response);
  return groth16.verify(VERIFICATION_KEY, publicSignals, proof);
};

/** Tek bir hex karakterini değiştirir. */
export const flipHex = (hex: string, index: number) =>
  hex.slice(0, index) + (hex[index] === '0' ? '1' : '0') + hex.slice(index + 1);

export function listen(app: { listen(port: number, callback: () => void): Server }) {
  return new Promise<{ server: Server; url: string }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

export const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
