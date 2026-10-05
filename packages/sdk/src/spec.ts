// Job spec hash'i: RFC 8785 (JCS) kanonik JSON + SHA-256, `create_job`'un `specHash` argümanı.
import { sha256 } from '@noble/hashes/sha2';
import { canonicalJson } from './canonical.js';

export interface SpecHashing {
  /** RFC 8785 kanonik JSON. */
  canonicalizeSpec(spec: unknown): string;
  /** SHA-256(canonicalizeSpec(spec)), 32 bayt. */
  specHash(spec: unknown): Uint8Array;
}

export const specHashing: SpecHashing = {
  canonicalizeSpec: (spec) => canonicalJson(spec, 'spec'),
  specHash: (spec) => sha256(new TextEncoder().encode(canonicalJson(spec, 'spec'))),
};
