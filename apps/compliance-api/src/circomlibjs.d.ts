declare module 'circomlibjs' {
  /**
   * Minimal type surface for the Poseidon helper exposed by circomlibjs.
   *
   * `buildPoseidon()` returns an instance that is BOTH callable (the hash
   * function itself) AND carries a `.F` property exposing the underlying
   * BN254 prime field with helpers like `toString(out)` to decode the byte
   * output as a decimal string. The published JS package has no .d.ts of
   * its own, so we pin the exact shape we use here.
   */
  export interface PoseidonField {
    toString(value: Uint8Array): string;
  }

  export interface Poseidon {
    (inputs: ReadonlyArray<bigint | string | number>): Uint8Array;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<Poseidon>;
}
