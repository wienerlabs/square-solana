import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox, parseSecretBoxKeys, SecretBoxError } from '../src/secret-box.js';

const key = () => new Uint8Array(randomBytes(32));

describe('createSecretBox', () => {
  const k1 = key();
  const k2 = key();

  it('şifreler ve açar; her şifreleme farklı IV kullanır', () => {
    const box = createSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealed = box.seal('stripe-connect-secret', 'institution:abc');
    expect(sealed).toMatch(/^sq1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain('stripe-connect-secret');
    expect(box.openText(sealed, 'institution:abc')).toBe('stripe-connect-secret');
    expect(box.seal('stripe-connect-secret', 'institution:abc')).not.toBe(sealed);
    const bytes = Uint8Array.of(0, 1, 2, 255);
    expect(Array.from(box.open(box.seal(bytes)))).toEqual([0, 1, 2, 255]);
  });

  it('bağlam (AAD), anahtar ve bütünlük denetlenir', () => {
    const box = createSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealed = box.seal('değer', 'kayıt:1');
    expect(() => box.open(sealed, 'kayıt:2')).toThrow(SecretBoxError);
    expect(() => box.open(sealed)).toThrow(/doğrulanamadı/);
    const [version, id, iv, body] = sealed.split('.') as [string, string, string, string];
    const flipped = `${body.slice(0, -2)}${body.endsWith('AA') ? 'AB' : 'AA'}`;
    expect(() => box.open([version, id, iv, flipped].join('.'), 'kayıt:1')).toThrow(/doğrulanamadı/);
    const other = createSecretBox({ keys: { k1: k2 }, activeKeyId: 'k1' });
    expect(() => other.open(sealed, 'kayıt:1')).toThrow(/doğrulanamadı/);
    expect(() => box.open('sq1.k9.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA')).toThrow(/halkada yok/);
    for (const broken of ['düz-metin', 'sq2.k1.a.b', 'sq1.k1.AAAA.AAAA']) {
      expect(() => box.open(broken)).toThrow(/biçimi/);
    }
  });

  it('anahtar döndürme: eski değerler açılır ve yeniden şifrelenmesi gerektiği bilinir', () => {
    const old = createSecretBox({ keys: { k1 }, activeKeyId: 'k1' });
    const sealed = old.seal('değer');
    const rotated = createSecretBox({ keys: { k1, k2 }, activeKeyId: 'k2' });
    expect(rotated.needsRotation(sealed)).toBe(true);
    expect(rotated.openText(sealed)).toBe('değer');
    const resealed = rotated.seal(rotated.open(sealed));
    expect(rotated.needsRotation(resealed)).toBe(false);
    expect(resealed.split('.')[1]).toBe('k2');
  });

  it('anahtar halkasını doğrular', () => {
    expect(() => createSecretBox({ keys: { k1 }, activeKeyId: 'k2' })).toThrow(/etkin anahtar/);
    expect(() => createSecretBox({ keys: { k1: new Uint8Array(16) }, activeKeyId: 'k1' })).toThrow(/32 bayt/);
    expect(() => createSecretBox({ keys: { 'kötü kimlik': k1 }, activeKeyId: 'kötü kimlik' })).toThrow(/kimliği/);
  });
});

describe('parseSecretBoxKeys', () => {
  it('kimlik:base64 listesini ayrıştırır', () => {
    const a = randomBytes(32).toString('base64');
    const b = randomBytes(32).toString('base64');
    const keys = parseSecretBoxKeys(` 2026a:${a}, 2026b:${b} `);
    expect(Object.keys(keys)).toEqual(['2026a', '2026b']);
    expect(keys['2026a']).toHaveLength(32);
    expect(() => parseSecretBoxKeys('')).toThrow(/en az bir/);
    expect(() => parseSecretBoxKeys('anahtarsız')).toThrow(/kimlik:base64/);
    expect(() => parseSecretBoxKeys(`k:${randomBytes(16).toString('base64')}`)).toThrow(/32 bayt/);
    expect(() => parseSecretBoxKeys(`k:${a},k:${b}`)).toThrow(/tekrar/);
  });
});
