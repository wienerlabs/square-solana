// Test fixture: Anchor'ın camelCase IDL'indeki bir tipe uyan örnek değer (Anchor'ın JS biçiminde). Değerler
// sayaçtan türetilir, her alan farklıdır; senaryo alanları `overrides` ile verilir.
import { BN, type Idl } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';

type IdlTypeLike =
  | string
  | { array: [IdlTypeLike, number] }
  | { vec: IdlTypeLike }
  | { option: IdlTypeLike }
  | { defined: { name: string } };

interface FieldLike {
  name: string;
  type: IdlTypeLike;
}
type FieldsLike = FieldLike[] | IdlTypeLike[];

let counter = 0;
const next = () => (counter += 1);

export function sampleValue(idl: Idl, type: IdlTypeLike): unknown {
  const types = new Map((idl.types ?? []).map((t) => [t.name, t]));
  const fields = (list: FieldsLike | undefined): unknown => {
    if (!list || list.length === 0) return {};
    if (typeof list[0] === 'object' && list[0] !== null && 'name' in list[0]) {
      return Object.fromEntries((list as FieldLike[]).map((f) => [f.name, value(f.type)]));
    }
    return (list as IdlTypeLike[]).map(value);
  };
  function value(t: IdlTypeLike): unknown {
    if (typeof t === 'string') {
      const n = next();
      switch (t) {
        case 'bool':
          return n % 2 === 0;
        case 'u8':
          return n % 256;
        case 'u16':
        case 'u32':
          return 300 + (n % 60_000);
        case 'u64':
          return new BN(1_000_000 + n);
        case 'i64':
          return new BN(1_790_000_000 + n);
        case 'pubkey':
          return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256));
        case 'string':
          return `square-${n}`;
        case 'bytes':
          return Buffer.from([n % 256, (n + 1) % 256]);
        default:
          throw new Error(`örnek değer üretilemeyen tip: ${t}`);
      }
    }
    if ('array' in t) {
      // [u8; N] hash / commitment: sıfır olmayan, alana özgü baytlar.
      const n = next();
      return Array.from({ length: t.array[1] }, (_, i) =>
        t.array[0] === 'u8' ? ((n + i) % 255) + 1 : value(t.array[0]),
      );
    }
    if ('vec' in t) return [value(t.vec), value(t.vec)];
    if ('option' in t) return value(t.option);
    const def = types.get(t.defined.name);
    if (!def) throw new Error(`IDL'de tip yok: ${t.defined.name}`);
    const body = def.type as { kind: string; fields?: FieldsLike; variants?: { name: string; fields?: FieldsLike }[] };
    if (body.kind === 'struct') return fields(body.fields);
    const variant = body.variants!.find((v) => v.fields && v.fields.length > 0) ?? body.variants!.at(-1)!;
    return { [variant.name]: fields(variant.fields) };
  }
  return value(type);
}

/** Tipin örnek değeri, verilen alanlar değiştirilmiş. */
export function sample(idl: Idl, name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(sampleValue(idl, { defined: { name } }) as Record<string, unknown>), ...overrides };
}
