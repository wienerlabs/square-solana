// Sabit zamanlı karşılaştırma: gizli değerler (API anahtarı, imza, belirteç) uzunluk ya da içerik
// zamanlamasıyla sızdırılmadan karşılaştırılır. İki taraf önce SHA-256'yla aynı uzunluğa getirilir;
// `timingSafeEqual` farklı uzunlukta girdiyi reddettiği için uzunluk da zamanlamaya yansımaz.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest();

/** `a` ve `b` bayt bayt aynı mı (dizeler UTF-8 olarak). */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  return timingSafeEqual(digest(a), digest(b));
}
