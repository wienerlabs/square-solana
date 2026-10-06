// snarkjs'in tip bildirimi yok; devnet testinin kullandığı yüzey (release ispatı, @squaresdk/solana-policy).
declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      input: unknown,
      wasm: unknown,
      zkey: unknown,
    ): Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }>;
  };
}
