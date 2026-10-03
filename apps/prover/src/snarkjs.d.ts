// snarkjs'in tip bildirimi yok; servisin kullandığı yüzey.
declare module 'snarkjs' {
  export interface MemFile {
    type: 'mem';
    data?: Uint8Array;
  }
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }
  export interface VerificationKey {
    protocol: string;
    curve: string;
    nPublic: number;
  }
  export const wtns: {
    calculate(input: Readonly<Record<string, unknown>>, wasm: MemFile, wtns: MemFile): Promise<void>;
  };
  export const groth16: {
    prove(zkey: MemFile, wtns: MemFile): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vk: VerificationKey, publicSignals: readonly string[], proof: Groth16Proof): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkey: MemFile): Promise<VerificationKey>;
  };
}
