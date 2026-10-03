// Adım 7: ispat. Yerel prover politikayı makineden çıkarmadan snarkjs ile ispat üretir; snarkjs
// (GPL-3.0) bu pakete dahil değildir, çağıran kendi kurduğu `groth16` nesnesini verir. Uzak prover
// `POST /v1/prove`'a gider; güven sınırı: servisi işleten politikayı görür (api-sdk-contract.md §5).
import { sha256 } from '@noble/hashes/sha2';
import { envelopeSchema, ProveResponseSchema, type ProveRequest, type ProveResponse } from '@squaresdk/solana-types';
import { BN254_R } from './fields.js';
import type { CircuitInputs, ReleaseWitness } from './witness.js';

export interface Prover {
  prove(witness: ReleaseWitness): Promise<ProveResponse>;
}

/** snarkjs Groth16 ispatı (JSON). */
export interface SnarkjsProof {
  pi_a: readonly string[];
  pi_b: readonly (readonly string[])[];
  pi_c: readonly string[];
}

/** snarkjs `groth16` nesnesinin kullanılan kısmı (`import { groth16 } from 'snarkjs'`). */
export interface Groth16Backend {
  fullProve(
    input: CircuitInputs,
    wasm: { type: 'mem'; data: Uint8Array },
    zkey: { type: 'mem'; data: Uint8Array },
  ): Promise<{ proof: SnarkjsProof; publicSignals: readonly string[] }>;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** BN254 taban alanı (G1 / G2 koordinatları). */
const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/**
 * snarkjs ispatı → groth16-solana bayt düzeni: G1 = x ‖ y, G2 = x1 ‖ x0 ‖ y1 ‖ y0 (big-endian);
 * proof_a eşleme denkleminde eksiyle girdiği için y yerine q − y.
 */
export function encodeProof(
  proof: SnarkjsProof,
  publicSignals: readonly string[],
): Omit<ProveResponse, 'artifactVersion' | 'provingMs'> {
  const coord = (value: string) => {
    const n = BigInt(value);
    if (n < 0n || n >= BN254_Q) throw new Error('koordinat taban alanı dışında');
    return n.toString(16).padStart(64, '0');
  };
  const [ax, ay] = proof.pi_a as [string, string];
  const [[bx0, bx1], [by0, by1]] = proof.pi_b as [[string, string], [string, string]];
  const [cx, cy] = proof.pi_c as [string, string];
  return {
    proofA: coord(ax) + coord(((BN254_Q - BigInt(ay)) % BN254_Q).toString()),
    proofB: coord(bx1) + coord(bx0) + coord(by1) + coord(by0),
    proofC: coord(cx) + coord(cy),
    publicInputs: publicSignals.map((signal) => {
      const n = BigInt(signal);
      if (n < 0n || n >= BN254_R) throw new Error('public sinyal skaler alan dışında');
      return n.toString(16).padStart(64, '0');
    }),
  };
}

/** Artefakt sürümü: zkey'in SHA-256'sı (manifest'teki `zkey.sha256`). */
export const artifactVersion = (zkey: Uint8Array): string => hex(sha256(zkey));

export function createLocalProver(config: { wasm: Uint8Array; zkey: Uint8Array; groth16: Groth16Backend }): Prover {
  const version = artifactVersion(config.zkey);
  return {
    async prove(witness) {
      const started = performance.now();
      const { proof, publicSignals } = await config.groth16.fullProve(
        witness.inputs,
        { type: 'mem', data: config.wasm },
        { type: 'mem', data: config.zkey },
      );
      return ProveResponseSchema.parse({
        artifactVersion: version,
        ...encodeProof(proof, publicSignals),
        provingMs: Math.round(performance.now() - started),
      });
    },
  };
}

const ProveEnvelope = envelopeSchema(ProveResponseSchema);

export function createRemoteProver(config: {
  /** API kök adresi; istek `${baseUrl}/v1/prove`'a gider. */
  baseUrl: string;
  apiKey: string;
  /** Beklenen zkey SHA-256'sı; prover başka bir anahtarla çalışıyorsa istek reddedilir. */
  artifactVersion: string;
  fetch?: typeof fetch;
}): Prover {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/prove`;
  const doFetch = config.fetch ?? fetch;
  return {
    async prove(witness) {
      const body: ProveRequest = {
        circuit: 'payment-compliance',
        artifactVersion: config.artifactVersion,
        witness: witness.inputs as ProveRequest['witness'],
      };
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify(body),
      });
      const envelope = ProveEnvelope.parse(await response.json());
      if (!envelope.success) throw new Error(`prover: ${envelope.error.code}: ${envelope.error.message}`);
      if (envelope.data.artifactVersion !== config.artifactVersion) {
        throw new Error(`prover başka bir anahtarla ispat üretti: ${envelope.data.artifactVersion}`);
      }
      return envelope.data;
    },
  };
}
