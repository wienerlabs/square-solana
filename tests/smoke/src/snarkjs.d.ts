// snarkjs'in tip bildirimi yok; kullanılan yüzey (`createLocalProver`'a verilen `groth16`).
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: unknown,
      wasm: { type: 'mem'; data: Uint8Array },
      zkey: { type: 'mem'; data: Uint8Array },
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
  };
}
