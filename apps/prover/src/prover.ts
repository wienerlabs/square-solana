// İspat: önce witness hesaplanır (devreyi sağlamayan girdi burada reddedilir), sonra Groth16 ispatı
// üretilir ve dönmeden önce doğrulama anahtarıyla doğrulanır. Çıktı groth16-solana bayt düzenindedir
// (`encodeProof`, @squaresdk/solana-policy). Witness politikanın kendisidir; hiçbir yere yazılmaz.
import { BN254_R, encodeProof } from '@squaresdk/solana-policy';
import { ProveResponseSchema, type ProveRequest, type ProveResponse } from '@squaresdk/solana-types';
import { groth16, wtns, type MemFile } from 'snarkjs';
import type { Artifacts } from './artifacts.js';
import { errorMessage } from './errors.js';

export type Witness = ProveRequest['witness'];

/** Girdi devreyi sağlamıyor ya da biçimi yanlış; istemci hatası. */
export class InvalidWitnessError extends Error {
  override readonly name = 'InvalidWitnessError';
}

/** Üretilen ispat doğrulanamadı; sunucu hatası. */
export class ProofSelfCheckError extends Error {
  override readonly name = 'ProofSelfCheckError';
}

export interface Prover {
  readonly version: string;
  prove(witness: Witness): Promise<ProveResponse>;
}

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Değerler kanonik ondalık ve skaler alanın içinde olmalı: witness hesaplayıcı negatif ya da
 * r'den büyük değeri sessizce mod r'ye indirir, hex'i de kabul eder.
 */
export function checkWitnessValues(witness: Witness): void {
  for (const [signal, value] of Object.entries(witness)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!CANONICAL_DECIMAL.test(item) || BigInt(item) >= BN254_R) {
        throw new InvalidWitnessError(`${signal}: kanonik ondalık alan elemanı değil`);
      }
    }
  }
}

/** snarkjs hata metninin ilk satırı (sinyal adı ya da şablon / satır; değer içermez). */
const firstLine = (error: unknown) => errorMessage(error).split('\n')[0]!.trim();

export function createProver(artifacts: Artifacts): Prover {
  const wasm: MemFile = { type: 'mem', data: artifacts.wasm };
  const zkey: MemFile = { type: 'mem', data: artifacts.zkey };
  return {
    version: artifacts.version,
    async prove(witness) {
      checkWitnessValues(witness);
      const started = performance.now();
      const witnessFile: MemFile = { type: 'mem' };
      try {
        await wtns.calculate(witness, wasm, witnessFile);
      } catch (error) {
        throw new InvalidWitnessError(`witness devreyi sağlamıyor: ${firstLine(error)}`);
      }
      const { proof, publicSignals } = await groth16.prove(zkey, witnessFile);
      if (!(await groth16.verify(artifacts.verificationKey, publicSignals, proof))) {
        throw new ProofSelfCheckError('üretilen ispat doğrulama anahtarıyla doğrulanmadı');
      }
      return ProveResponseSchema.parse({
        artifactVersion: artifacts.version,
        ...encodeProof(proof, publicSignals),
        provingMs: Math.round(performance.now() - started),
      });
    },
  };
}
