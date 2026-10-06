// Webhook imzası ve tekrar oynatma koruması, Standard Webhooks spesifikasyonuyla
// (https://www.standardwebhooks.com): `webhook-id`, `webhook-timestamp`, `webhook-signature` başlıkları;
// imza `v1,<base64(HMAC-SHA256(anahtar, id.zaman.gövde))>`, sır `whsec_<base64>`. Alıcı zaman damgasını
// tolerans penceresine göre, imzayı sabit zamanlı karşılaştırmayla denetler ve teslimat kimliğini pencere
// süresince bir kez kabul eder. Sır döndürülürken eski ve yeni sır birlikte verilir. Sıfırdan yazıldı
// (BC-03: Covenant'ın webhook kodu kullanılmaz).
import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './secure-compare.js';
import type { ReplayStore } from './stores.js';

const SECRET_PREFIX = 'whsec_';
const VERSION = 'v1';

export const WEBHOOK_HEADERS = Object.freeze({
  id: 'webhook-id',
  timestamp: 'webhook-timestamp',
  signature: 'webhook-signature',
});

export type WebhookFailure =
  'missing_headers' | 'invalid_timestamp' | 'timestamp_out_of_range' | 'invalid_signature' | 'replayed';

export class WebhookVerificationError extends Error {
  constructor(
    readonly reason: WebhookFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Yeni webhook sırrı: `whsec_` + 32 rastgele baytın base64'ü. */
export const generateWebhookSecret = (): string => `${SECRET_PREFIX}${randomBytes(32).toString('base64')}`;

function secretKey(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('webhook sırrı whsec_ ile başlamalı');
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  if (key.length < 24) throw new Error('webhook sırrı en az 24 bayt olmalı');
  return key;
}

const sign = (key: Buffer, id: string, timestamp: number, payload: string) =>
  createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');

/** Gönderilecek isteğin başlıkları. `timestamp` Unix saniyesidir. */
export function signWebhook(params: {
  secret: string;
  id: string;
  timestamp: number;
  payload: string;
}): Record<string, string> {
  const signature = sign(secretKey(params.secret), params.id, params.timestamp, params.payload);
  return {
    [WEBHOOK_HEADERS.id]: params.id,
    [WEBHOOK_HEADERS.timestamp]: String(params.timestamp),
    [WEBHOOK_HEADERS.signature]: `${VERSION},${signature}`,
  };
}

const header = (headers: Readonly<Record<string, string | string[] | undefined>>, name: string) => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(entry) ? entry[0] : entry;
};

/**
 * Gelen webhook'u doğrular: zaman damgası `toleranceSeconds` içinde, imza sırlardan biriyle geçerli,
 * teslimat kimliği daha önce kabul edilmemiş. İmza geçmeden kimlik kaydedilmez (sahte istek kimlik
 * tüketemez). Gövde ayrıştırılmadan, alındığı haliyle verilmelidir.
 */
export async function verifyWebhook(params: {
  secrets: readonly string[];
  headers: Readonly<Record<string, string | string[] | undefined>>;
  payload: string;
  toleranceSeconds: number;
  replay: ReplayStore;
  /** Tekrar koruması kapsamı (ör. gönderenin adı). */
  scope: string;
  now?: Date;
}): Promise<{ id: string; timestamp: number }> {
  if (params.secrets.length === 0) throw new Error('en az bir webhook sırrı gerekli');
  const now = params.now ?? new Date();
  const id = header(params.headers, WEBHOOK_HEADERS.id);
  const timestampText = header(params.headers, WEBHOOK_HEADERS.timestamp);
  const signatures = header(params.headers, WEBHOOK_HEADERS.signature);
  if (!id || !timestampText || !signatures) {
    throw new WebhookVerificationError('missing_headers', 'webhook başlıkları eksik');
  }
  if (!/^\d{1,12}$/.test(timestampText)) {
    throw new WebhookVerificationError('invalid_timestamp', 'zaman damgası Unix saniyesi değil');
  }
  const timestamp = Number(timestampText);
  if (Math.abs(now.getTime() / 1000 - timestamp) > params.toleranceSeconds) {
    throw new WebhookVerificationError('timestamp_out_of_range', 'zaman damgası tolerans penceresinin dışında');
  }
  const expected = params.secrets.map((secret) => sign(secretKey(secret), id, timestamp, params.payload));
  const provided = signatures
    .split(' ')
    .filter((entry) => entry.startsWith(`${VERSION},`))
    .map((entry) => entry.slice(VERSION.length + 1));
  const valid = provided.some((signature) => expected.some((candidate) => safeEqual(signature, candidate)));
  if (!valid) throw new WebhookVerificationError('invalid_signature', 'imza geçersiz');
  // Kimlik, zaman damgası pencere dışına çıkana kadar tutulur; sonrasında zaten zaman denetimi reddeder.
  const expiresAt = new Date((timestamp + params.toleranceSeconds) * 1000);
  if (!(await params.replay.claim(params.scope, id, expiresAt, now))) {
    throw new WebhookVerificationError('replayed', 'bu teslimat daha önce kabul edildi');
  }
  return { id, timestamp };
}
