// RFC 8785 (JCS) kanonik JSON: spec hash'i (`spec.ts`) ve Travel Rule kaydının özeti (`travel-rule.ts`).
//
// RFC 8785, ECMAScript'in JSON serileştirmesine dayanır: sayılar ve dizeler `JSON.stringify`
// ile, nesne anahtarları UTF-16 kod birimi sırasıyla yazılır. Girdi önce saf JSON olarak
// denetlenir (I-JSON): sonlu olmayan sayı, tek başına surrogate, `undefined`, fonksiyon ya da
// düz olmayan nesne reddedilir; aynı değerin iki tarafta farklı hash'lenmemesi için.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) throw new Error(`${path}: geçersiz UTF-16 (tek başına surrogate)`);
  return JSON.stringify(value);
}

/** UTF-16 kod birimi sırası (RFC 8785 §3.2.3); `<` dizeleri bu sırayla karşılaştırır. */
const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** `value`'nun RFC 8785 kanonik JSON'u; `path` hata mesajındaki yerdir. */
export function canonicalJson(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return serializeString(value, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path}: sonlu olmayan sayı`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error(`${path}: düz JSON nesnesi değil`);
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => byCodeUnits(a, b));
    return `{${entries.map(([key, item]) => `${serializeString(key, path)}:${canonicalJson(item, `${path}.${key}`)}`).join(',')}}`;
  }
  throw new Error(`${path}: JSON değeri değil (${typeof value})`);
}
