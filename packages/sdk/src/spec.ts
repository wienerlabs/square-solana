// Job spec hash'i sözleşmesi: RFC 8785 (JCS) kanonik JSON + SHA-256, `create_job`'un `specHash` argümanı.
// Uygulama BE-08'de; bu dosya yalnızca arayüzü tanımlar.

export interface SpecHashing {
  /** RFC 8785 kanonik JSON. */
  canonicalizeSpec(spec: unknown): string;
  /** SHA-256(canonicalizeSpec(spec)), 32 bayt. */
  specHash(spec: unknown): Uint8Array;
}
