// Test fixture (packages/a2a/test/helpers/idl-sample.ts ile aynı): bir IDL tipine uyan örnek değer üretir
// (Anchor'ın JS biçiminde). Testler hesabın ilgilendikleri alanlarını üzerine yazar.
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

export function createSampler(idl: Idl) {
  let counter = 0;
  const next = () => (counter += 1);
  const types = new Map((idl.types ?? []).map((t) => [t.name, t]));

  const fields = (list: FieldsLike | undefined): unknown => {
    if (!list || list.length === 0) return {};
    if (typeof list[0] === 'object' && list[0] !== null && 'name' in list[0]) {
      return Object.fromEntries((list as FieldLike[]).map((f) => [f.name, value(f.type)]));
    }
    return (list as IdlTypeLike[]).map(value);
  };

  function value(type: IdlTypeLike): unknown {
    if (typeof type === 'string') {
      const n = next();
      switch (type) {
        case 'bool':
          return n % 2 === 0;
        case 'u8':
          return n % 256;
        case 'u16':
        case 'u32':
          return 300 + n;
        case 'u64':
          return new BN(1_000 + n);
        case 'i64':
          return new BN(1_790_000_000 + n);
        case 'pubkey':
          return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i) % 256));
        case 'string':
          return `square-${n}`;
        default:
          throw new Error(`örnek değer üretilemeyen tip: ${type}`);
      }
    }
    if ('array' in type) return Array.from({ length: type.array[1] }, () => value(type.array[0]));
    if ('vec' in type) return [value(type.vec), value(type.vec)];
    if ('option' in type) return null;
    const def = types.get(type.defined.name);
    if (!def) throw new Error(`IDL'de tip yok: ${type.defined.name}`);
    const body = def.type as { kind: string; fields?: FieldsLike; variants?: { name: string; fields?: FieldsLike }[] };
    if (body.kind === 'struct') return fields(body.fields);
    if (body.kind === 'enum') {
      const variant = body.variants![0]!;
      return { [variant.name]: fields(variant.fields) };
    }
    throw new Error(`desteklenmeyen tip türü: ${body.kind}`);
  }

  return { struct: (name: string) => value({ defined: { name } }) as Record<string, unknown> };
}
