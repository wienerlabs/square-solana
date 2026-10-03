// Teslimatın zincirdeki taahhüdü: `submit_work`'ün `workHash` argümanı içeriğin SHA-256'sıdır
// (`DeliveryReceipt.workHash`). İçeriği yükleyip URI almak API'nin işidir (`SquareApi.uploadDelivery`).
import { sha256 } from '@noble/hashes/sha2';

/** Teslim edilen içeriğin SHA-256'sı, 32 bayt. Metin UTF-8 olarak hash'lenir. */
export function workHash(content: Uint8Array | string): Uint8Array {
  return sha256(typeof content === 'string' ? new TextEncoder().encode(content) : content);
}
