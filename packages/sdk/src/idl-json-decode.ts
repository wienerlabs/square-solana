// IDL JSON → Anchor değeri: `toIdlJson`'un tersi (api-sdk-contract §3). API'nin `POST /v1/tx` isteğindeki
// instruction argümanları bu kuralla Anchor'ın kodlayıcısına verilir. Tip bilgisi Anchor'ın camelCase
// IDL'inden okunur. Beklenen biçimde olmayan değer, alanın yoluyla hata verir; yanlış bir değer kodlanmaz.
import { BN, type Idl, type IdlDefinedFields, type IdlField, type IdlType, type IdlTypeDef } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';

const INT_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  u8: [0, 255],
  u16: [0, 65_535],
  u32: [0, 4_294_967_295],
  i8: [-128, 127],
  i16: [-32_768, 32_767],
  i32: [-2_147_483_648, 2_147_483_647],
};
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)$/;
const HEX = /^([0-9a-f]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** Geçersiz argüman: `path` alanın yolu (ör. `args.params.keeperFeeBps`). */
export class IdlJsonError extends Error {
  constructor(
    /** Geçersiz alanın yolu. */
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'IdlJsonError';
  }
}

function decimal(path: string, value: unknown, min: bigint, max: bigint): BN {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new IdlJsonError(path, 'ondalık dize bekleniyordu');
  const big = BigInt(value);
  if (big < min || big > max) throw new IdlJsonError(path, 'aralık dışında');
  return new BN(value, 10);
}

function primitive(type: string, value: unknown, path: string): unknown {
  switch (type) {
    case 'pubkey':
      if (typeof value !== 'string' || !BASE58.test(value)) throw new IdlJsonError(path, 'base58 adres bekleniyordu');
      try {
        return new PublicKey(value);
      } catch {
        throw new IdlJsonError(path, 'geçerli bir adres değil');
      }
    case 'u64':
      return decimal(path, value, 0n, U64_MAX);
    case 'u128':
      return decimal(path, value, 0n, U128_MAX);
    case 'i128':
      return decimal(path, value, I128_MIN, I128_MAX);
    case 'i64':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new IdlJsonError(path, 'güvenli tamsayı aralığında sayı bekleniyordu');
      }
      return new BN(value);
    case 'bool':
      if (typeof value !== 'boolean') throw new IdlJsonError(path, 'boolean bekleniyordu');
      return value;
    case 'string':
      if (typeof value !== 'string') throw new IdlJsonError(path, 'dize bekleniyordu');
      return value;
    case 'bytes':
      if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) {
        throw new IdlJsonError(path, 'base64 bekleniyordu');
      }
      return Buffer.from(value, 'base64');
    default: {
      const range = INT_RANGES[type];
      if (!range) throw new IdlJsonError(path, `desteklenmeyen tip ${type}`);
      if (typeof value !== 'number' || !Number.isInteger(value) || value < range[0] || value > range[1]) {
        throw new IdlJsonError(path, `${type} aralığında tamsayı bekleniyordu`);
      }
      return value;
    }
  }
}

function object(path: string, value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdlJsonError(path, 'nesne bekleniyordu');
  }
  return value as Record<string, unknown>;
}

function fields(
  idl: Idl,
  list: IdlDefinedFields | undefined,
  value: Record<string, unknown>,
  path: string,
  /** Tipin alanı olmayan ama izin verilen anahtarlar (veri taşıyan enum'un `kind`'ı). */
  extra: readonly string[] = [],
) {
  const unknownKeys = (names: readonly string[]) =>
    Object.keys(value).filter((key) => !extra.includes(key) && !names.includes(key));
  if (!list || list.length === 0) {
    const unknown = unknownKeys([]);
    if (unknown.length > 0) throw new IdlJsonError(path, `bilinmeyen alan: ${unknown.join(', ')}`);
    return {};
  }
  if (typeof list[0] !== 'object' || !('name' in list[0])) {
    throw new IdlJsonError(path, 'demet alanlı tip desteklenmiyor');
  }
  const named = list as IdlField[];
  const unknown = unknownKeys(named.map((field) => field.name));
  if (unknown.length > 0) throw new IdlJsonError(path, `bilinmeyen alan: ${unknown.join(', ')}`);
  return Object.fromEntries(
    named.map((field) => {
      if (!(field.name in value)) throw new IdlJsonError(`${path}.${field.name}`, 'alan eksik');
      return [field.name, decode(idl, field.type, value[field.name], `${path}.${field.name}`)];
    }),
  );
}

function defined(idl: Idl, def: IdlTypeDef, value: unknown, path: string): unknown {
  const body = def.type;
  if (body.kind === 'struct') return fields(idl, body.fields, object(path, value), path);
  if (body.kind !== 'enum') throw new IdlJsonError(path, `desteklenmeyen tip türü ${body.kind}`);
  const hasData = body.variants.some((variant) => variant.fields && variant.fields.length > 0);
  const kind = hasData ? object(path, value).kind : value;
  if (typeof kind !== 'string')
    throw new IdlJsonError(path, hasData ? '`kind` alanı bekleniyordu' : 'dize bekleniyordu');
  const variant = body.variants.find((candidate) => lowerFirst(candidate.name) === kind);
  if (!variant) throw new IdlJsonError(path, `${def.name} için bilinmeyen değer: ${kind}`);
  const data = hasData ? fields(idl, variant.fields, value as Record<string, unknown>, path, ['kind']) : {};
  return { [variant.name]: data };
}

function decode(idl: Idl, type: IdlType, value: unknown, path: string): unknown {
  if (typeof type === 'string') return primitive(type, value, path);
  if ('option' in type) return value === null ? null : decode(idl, type.option, value, path);
  if ('vec' in type) {
    if (!Array.isArray(value)) throw new IdlJsonError(path, 'dizi bekleniyordu');
    return value.map((item, index) => decode(idl, type.vec, item, `${path}[${index}]`));
  }
  if ('array' in type) {
    const [inner, length] = type.array;
    if (typeof length !== 'number') throw new IdlJsonError(path, 'generic dizi uzunluğu desteklenmiyor');
    if (inner === 'u8') {
      if (typeof value !== 'string' || value.length !== length * 2 || !HEX.test(value)) {
        throw new IdlJsonError(path, `${length} baytlık küçük harf hex bekleniyordu`);
      }
      return Array.from(Buffer.from(value, 'hex'));
    }
    if (!Array.isArray(value) || value.length !== length)
      throw new IdlJsonError(path, `${length} öğeli dizi bekleniyordu`);
    return value.map((item, index) => decode(idl, inner, item, `${path}[${index}]`));
  }
  if ('defined' in type) {
    const def = (idl.types ?? []).find((candidate) => candidate.name === type.defined.name);
    if (!def) throw new IdlJsonError(path, `IDL'de ${type.defined.name} tipi yok`);
    if (type.defined.generics?.length || def.generics?.length)
      throw new IdlJsonError(path, 'generic tip desteklenmiyor');
    return defined(idl, def, value, path);
  }
  throw new IdlJsonError(path, `desteklenmeyen tip ${JSON.stringify(type)}`);
}

/**
 * IDL JSON'unu Anchor değerine çevirir. `idl` Anchor'ın camelCase IDL'idir (`client.escrow.program.idl`);
 * instruction argümanı için tip `idl.instructions[i].args[j].type`'tır.
 */
export function fromIdlJson(idl: Idl, type: IdlType, value: unknown, path = 'değer'): unknown {
  return decode(idl, type, value, path);
}
