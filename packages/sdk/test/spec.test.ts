import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { workHash } from '../src/delivery.js';
import { specHashing } from '../src/spec.js';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest();

// RFC 8785 test vektörlerindeki özel karakterler kod noktalarından kurulur (kaynakta kaçış dizisi yok).
const ch = (...codes: number[]) => String.fromCodePoint(...codes);
const BS = ch(0x5c);
const Q = ch(0x22);
const EURO = ch(0x20ac);

describe('RFC 8785 (JCS)', () => {
  it('RFC 8785 §3.2.2 örneği', () => {
    const input = {
      // RFC girdisindeki 333333333.33333329 aynı double'a ayrışır; JSON metninden okunur.
      numbers: [JSON.parse('333333333.33333329') as number, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: `${EURO}$${ch(0x0f)}${ch(0x0a)}A'B${Q}${BS}${BS}${Q}/`,
      literals: [null, true, false],
    };
    const expected =
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' +
      `${EURO}$${BS}u000f${BS}nA'B${BS}${Q}${BS}${BS}${BS}${BS}${BS}${Q}/"}`;
    expect(specHashing.canonicalizeSpec(input)).toBe(expected);
  });

  it('RFC 8785 §3.2.3: anahtarlar UTF-16 kod birimi sırasıyla', () => {
    const keys = [0x20ac, 0x0d, 0xfb33, 0x31, 0x1f600, 0x80, 0xf6].map((code) => ch(code));
    const input = Object.fromEntries(keys.map((key, index) => [key, index]));
    const order = [0x0d, 0x31, 0x80, 0xf6, 0x20ac, 0x1f600, 0xfb33].map((code) => ch(code));
    const expected = `{${order.map((key) => `${JSON.stringify(key)}:${keys.indexOf(key)}`).join(',')}}`;
    expect(specHashing.canonicalizeSpec(input)).toBe(expected);
  });

  it('-0 ve iç içe yapılar', () => {
    expect(specHashing.canonicalizeSpec({ b: [{ z: -0, a: 'x' }], a: {} })).toBe('{"a":{},"b":[{"a":"x","z":0}]}');
    expect(specHashing.canonicalizeSpec(Object.assign(Object.create(null), { k: 1 }))).toBe('{"k":1}');
  });

  it('JSON olmayan değerleri reddeder', () => {
    const loneHigh = ch(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const bad: unknown[] = [
      NaN,
      Infinity,
      undefined,
      1n,
      () => 1,
      new Date(0),
      new Map(),
      Symbol('s'),
      { a: undefined },
      [undefined],
      loneHigh,
      { [loneLow]: 1 },
    ];
    for (const value of bad) expect(() => specHashing.canonicalizeSpec(value)).toThrow();
  });

  it('specHash = SHA-256(kanonik JSON)', () => {
    const spec = { title: 'Çeviri', budget: 100, tags: ['tr', 'en'] };
    expect(Buffer.from(specHashing.specHash(spec))).toEqual(sha256(specHashing.canonicalizeSpec(spec)));
    expect(specHashing.specHash({ a: 1, b: 2 })).toEqual(specHashing.specHash({ b: 2, a: 1 }));
  });
});

describe('workHash', () => {
  it("içeriğin SHA-256'sı; metin UTF-8", () => {
    const text = `teslimat ${ch(0x2713)}`;
    expect(Buffer.from(workHash(text))).toEqual(sha256(Buffer.from(text, 'utf8')));
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    expect(Buffer.from(workHash(bytes))).toEqual(sha256(bytes));
  });
});
