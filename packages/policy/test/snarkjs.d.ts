// snarkjs'in tip bildirimi yok; testlerin kullandığı yüzey.
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: unknown,
      wasm: unknown,
      zkey: unknown,
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
    verify(vk: unknown, publicSignals: readonly string[], proof: unknown): Promise<boolean>;
  };
}
