// Job spec hash'i: RFC 8785 (JCS) kanonik JSON + SHA-256. `create_job`'un `specHash` argümanı.
import { NotImplementedError } from '@squaresdk/solana-types';

/** RFC 8785 kanonik JSON. */
export function canonicalizeSpec(spec: unknown): string {
  throw new NotImplementedError('canonicalizeSpec', 'BE-08');
}

/** SHA-256(canonicalizeSpec(spec)), 32 bayt. */
export function specHash(spec: unknown): Uint8Array {
  throw new NotImplementedError('specHash', 'BE-08');
}
