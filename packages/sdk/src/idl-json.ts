// IDL JSON kodlaması (api-sdk-contract §3): Anchor'ın çözdüğü değer (PublicKey, BN, sayı dizisi, `{ varyant:
// {…} }` enum'u) → API, indexer ve veritabanının JSON biçimi. Kural `@squaresdk/solana-types`'ın IDL'den
// üretilen şemalarıyla aynıdır:
//   pubkey → base58 · u64 / u128 / i128 → ondalık dize · i64 ve 32 bit'e kadar tamsayılar → sayı
//   bytes → base64 · [u8; N] → küçük harf hex · [T; N] / vec<T> → dizi · option<T> → T | null
//   veri taşımayan enum → camelCase dize · veri taşıyan enum → `kind` alanlı nesne · alan adları camelCase
// Tip bilgisi Anchor'ın camelCase IDL'inden (`Program.idl`) okunur; değer bu IDL'in çözücüsünden gelir.
// Beklenen biçimde olmayan değer hata verir: JSON'a yanlış bir değer yazılmaz.
import { BN, type Idl, type IdlDefinedFields, type IdlField, type IdlType, type IdlTypeDef } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';

export type IdlJson = string | number | boolean | null | IdlJson[] | { [key: string]: IdlJson };

const INT_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  i8: [-128, 127],
  i16: [-32_768, 32_767],
  i32: [-2_147_483_648, 2_147_483_647],
};

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

const fail = (path: string, expected: string, value: unknown): never => {
  const shown = value === null || value === undefined ? String(value) : (value.constructor?.name ?? typeof value);
  throw new Error(`IDL JSON: ${path}: ${expected} bekleniyordu (${shown})`);
};

function bigValue(path: string, value: unknown): bigint {
  if (BN.isBN(value)) return BigInt((value as BN).toString(10));
  if (typeof value === 'bigint') return value;
  return fail(path, 'BN', value);
}

function bytesOf(path: string, value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  return fail(path, 'bayt dizisi', value);
}

function primitive(type: string, value: unknown, path: string): IdlJson {
  switch (type) {
    case 'pubkey':
      return value instanceof PublicKey ? value.toBase58() : fail(path, 'PublicKey', value);
    case 'u64':
    case 'u128': {
      const big = bigValue(path, value);
      return big >= 0n ? big.toString() : fail(path, 'negatif olmayan tamsayı', value);
    }
    case 'i128':
      return bigValue(path, value).toString();
    case 'i64': {
      const big = bigValue(path, value);
      const number = Number(big);
      return Number.isSafeInteger(number) ? number : fail(path, 'güvenli tamsayı aralığında i64', value);
    }
    case 'bool':
      return typeof value === 'boolean' ? value : fail(path, 'boolean', value);
    case 'string':
      return typeof value === 'string' ? value : fail(path, 'string', value);
    case 'bytes':
      return Buffer.from(bytesOf(path, value)).toString('base64');
    default: {
      const range = INT_RANGES[type];
      if (!range) throw new Error(`IDL JSON: ${path}: desteklenmeyen tip ${type}`);
      return typeof value === 'number' && Number.isInteger(value) && value >= range[0] && value <= range[1]
        ? value
        : fail(path, type, value);
    }
  }
}

function fields(idl: Idl, list: IdlDefinedFields | undefined, value: unknown, path: string): IdlJson {
  if (value === null || typeof value !== 'object') return fail(path, 'nesne', value);
  if (!list || list.length === 0) return {};
  if (typeof list[0] === 'object' && 'name' in list[0]) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      (list as IdlField[]).map((field) => {
        if (!(field.name in record)) throw new Error(`IDL JSON: ${path}.${field.name}: alan yok`);
        return [field.name, encode(idl, field.type, record[field.name], `${path}.${field.name}`)];
      }),
    );
  }
  if (!Array.isArray(value) && !('0' in value)) return fail(path, 'demet', value);
  const tuple = value as Record<number, unknown>;
  return (list as IdlType[]).map((type, index) => encode(idl, type, tuple[index], `${path}[${index}]`));
}

function defined(idl: Idl, def: IdlTypeDef, value: unknown, path: string): IdlJson {
  const body = def.type;
  if (body.kind === 'struct') return fields(idl, body.fields, value, path);
  if (body.kind === 'enum') {
    if (value === null || typeof value !== 'object') return fail(path, 'enum nesnesi', value);
    const keys = Object.keys(value);
    if (keys.length !== 1) return fail(path, 'tek varyantlı enum nesnesi', value);
    const key = keys[0]!;
    const variant = body.variants.find((v) => lowerFirst(v.name) === lowerFirst(key));
    if (!variant) throw new Error(`IDL JSON: ${path}: ${def.name} enum'unda ${key} varyantı yok`);
    const kind = lowerFirst(variant.name);
    if (!body.variants.some((v) => v.fields && v.fields.length > 0)) return kind;
    const data = fields(idl, variant.fields, (value as Record<string, unknown>)[key], `${path}.${key}`);
    if (Array.isArray(data)) throw new Error(`IDL JSON: ${path}: demet alanlı enum varyantı desteklenmiyor`);
    return { kind, ...(data as Record<string, IdlJson>) };
  }
  throw new Error(`IDL JSON: ${path}: desteklenmeyen tip türü ${body.kind}`);
}

function encode(idl: Idl, type: IdlType, value: unknown, path: string): IdlJson {
  if (typeof type === 'string') return primitive(type, value, path);
  if ('option' in type) return value === null || value === undefined ? null : encode(idl, type.option, value, path);
  if ('vec' in type) {
    return Array.isArray(value)
      ? value.map((item, index) => encode(idl, type.vec, item, `${path}[${index}]`))
      : fail(path, 'dizi', value);
  }
  if ('array' in type) {
    const [inner, length] = type.array;
    if (typeof length !== 'number') throw new Error(`IDL JSON: ${path}: generic dizi uzunluğu desteklenmiyor`);
    if (inner === 'u8') {
      const bytes = bytesOf(path, value);
      return bytes.length === length ? Buffer.from(bytes).toString('hex') : fail(path, `${length} bayt`, value);
    }
    if (!Array.isArray(value) || value.length !== length) return fail(path, `${length} öğeli dizi`, value);
    return value.map((item, index) => encode(idl, inner, item, `${path}[${index}]`));
  }
  if ('defined' in type) {
    const def = (idl.types ?? []).find((candidate) => candidate.name === type.defined.name);
    if (!def) throw new Error(`IDL JSON: ${path}: IDL'de ${type.defined.name} tipi yok`);
    if (type.defined.generics?.length || def.generics?.length) {
      throw new Error(`IDL JSON: ${path}: generic tip desteklenmiyor`);
    }
    return defined(idl, def, value, path);
  }
  throw new Error(`IDL JSON: ${path}: desteklenmeyen tip ${JSON.stringify(type)}`);
}

/**
 * Anchor değerini IDL JSON'una çevirir. `idl` Anchor'ın camelCase IDL'idir (`client.escrow.program.idl`);
 * hesap ve event tipleri IDL'in `types` listesinde adlarıyla bulunur: `{ defined: { name: 'job' } }`.
 */
export function toIdlJson(idl: Idl, type: IdlType, value: unknown): IdlJson {
  return encode(idl, type, value, typeof type === 'object' && 'defined' in type ? type.defined.name : 'değer');
}
