// IDL sabitlerine erişim. JSON IDL'de adlar SNAKE_CASE, Anchor'ın dönüştürdüğü IDL'de camelCase;
// ikisi de aynı sabite çözülür.
import type { Idl } from '@anchor-lang/core';

const normalize = (name: string) => name.replace(/_/g, '').toLowerCase();

/** `bytes` tipli bir IDL sabitinin baytları (ör. PDA seed'i). Yoksa hata fırlatır. */
export function idlBytesConstant(idl: Idl, name: string): Uint8Array {
  const constant = (idl.constants ?? []).find((c) => normalize(c.name) === normalize(name));
  if (!constant) throw new Error(`IDL ${idl.metadata.name}: ${name} sabiti yok`);
  if (constant.type !== 'bytes') throw new Error(`IDL ${idl.metadata.name}: ${name} bytes değil`);
  const values: unknown = JSON.parse(constant.value);
  if (!Array.isArray(values) || !values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
    throw new Error(`IDL ${idl.metadata.name}: ${name} geçerli bir bayt dizisi değil`);
  }
  return Uint8Array.from(values as number[]);
}
