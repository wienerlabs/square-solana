// Test fixture (packages/sdk/test/helpers ile aynı): bir IDL tipine uyan örnek değer üretir (Anchor'ın JS biçiminde) ve karşılaştırma
// için değerleri düz JSON'a indirger. Değerler sayaçtan türetilir; her alan farklıdır.
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
        case 'i8':
          return -(n % 128);
        case 'u16':
        case 'u32':
          return 300 + n;
        case 'i16':
        case 'i32':
          return -(300 + n);
        case 'u64':
        case 'u128':
          return new BN('18446744073709551000').addn(n);
        case 'i64':
        case 'i128':
          return new BN(1_790_000_000 + n);
        case 'pubkey':
          return new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i) % 256));
        case 'string':
          return `square-${n}`;
        case 'bytes':
          return Buffer.from([n % 256, (n + 1) % 256]);
        default:
          throw new Error(`örnek değer üretilemeyen tip: ${type}`);
      }
    }
    if ('array' in type) return Array.from({ length: type.array[1] }, () => value(type.array[0]));
    if ('vec' in type) return [value(type.vec), value(type.vec)];
    if ('option' in type) return value(type.option);
    const def = types.get(type.defined.name);
    if (!def) throw new Error(`IDL'de tip yok: ${type.defined.name}`);
    const body = def.type as { kind: string; fields?: FieldsLike; variants?: { name: string; fields?: FieldsLike }[] };
    if (body.kind === 'struct') return fields(body.fields);
    if (body.kind === 'enum') {
      // Veri taşıyan varyant varsa onu seç; kodlamanın en çok yolunu dener.
      const variant = body.variants!.find((v) => v.fields && v.fields.length > 0) ?? body.variants!.at(-1)!;
      return { [variant.name]: fields(variant.fields) };
    }
    throw new Error(`desteklenmeyen tip türü: ${body.kind}`);
  }

  return { value, struct: (name: string) => value({ defined: { name } }) as Record<string, unknown> };
}

/** BN → ondalık dize, PublicKey → base58, baytlar → dizi; karşılaştırma için. */
export function plain(input: unknown): unknown {
  if (BN.isBN(input)) return (input as BN).toString();
  if (input instanceof PublicKey) return input.toBase58();
  if (input instanceof Uint8Array) return Array.from(input);
  if (Array.isArray(input)) return input.map(plain);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, plain(v)]));
  }
  return input;
}
