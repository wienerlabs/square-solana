import { describe, expect, it } from 'vitest';
import { safeEqual } from '../src/secure-compare.js';

describe('safeEqual', () => {
  it('aynı değerler eşit, farklı içerik ya da uzunluk eşit değil', () => {
    expect(safeEqual('api-key-1', 'api-key-1')).toBe(true);
    expect(safeEqual('api-key-1', 'api-key-2')).toBe(false);
    expect(safeEqual('kısa', 'çok daha uzun bir değer')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(new TextEncoder().encode('değer'), 'değer')).toBe(true);
    expect(safeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
  });
});
