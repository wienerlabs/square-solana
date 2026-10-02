// JSON kodlaması için temel şemalar. Kurallar: packages/types/scripts/gen-idl-schemas.mjs başlığı.
import { z } from 'zod';

const U64_MAX = 2n ** 64n - 1n;

/** Base58 Solana adresi (32 bayt). */
export const Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'base58 Solana adresi bekleniyor');
export type Address = z.infer<typeof Address>;

/** u64 ondalık string; JS number hassasiyetini aşmamak için string taşınır. */
export const U64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, 'ondalık u64 bekleniyor')
  .refine((v) => BigInt(v) <= U64_MAX, 'u64 aralığı dışında');
export type U64 = z.infer<typeof U64>;

/** i128 ondalık string. */
export const I128 = z.string().regex(/^-?(0|[1-9][0-9]{0,38})$/, 'ondalık i128 bekleniyor');

/** i64; sözleşmede yalnızca unix saniyeleri ve süreler için kullanılır, güvenli tamsayı aralığında kalır. */
export const I64 = z.number().int().refine(Number.isSafeInteger, 'güvenli tamsayı aralığı dışında');

/** `n` bayt, küçük harf hex. */
export const hexBytes = (n: number) => z.string().regex(new RegExp(`^[0-9a-f]{${n * 2}}$`), `${n} bayt hex bekleniyor`);

/** 32 bayt hash / commitment, küçük harf hex. */
export const Hex32 = hexBytes(32);
export type Hex32 = z.infer<typeof Hex32>;

/** Base64 (standart alfabe). */
export const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64 bekleniyor');

/** Base58 tx imzası (64 bayt). */
export const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'base58 imza bekleniyor');

/** Unix saniyesi. */
export const UnixSeconds = I64;

/** W3C DID. */
export const Did = z.string().regex(/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/, 'DID bekleniyor');

/** Solana kümesi. */
export const Cluster = z.enum(['mainnet-beta', 'devnet', 'testnet', 'localnet']);
export type Cluster = z.infer<typeof Cluster>;
