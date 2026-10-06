import { describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  WEBHOOK_HEADERS,
  WebhookVerificationError,
} from '../src/webhook.js';
import { memoryReplayStore } from './memory-stores.js';

const NOW = new Date('2026-10-06T09:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);
const payload = JSON.stringify({ type: 'job.released', job: 'JobPda111', amount: '248750000' });

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
    return 'kabul edildi';
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
    throw error;
  }
}

describe('webhook', () => {
  const secret = generateWebhookSecret();
  const verify = (
    headers: Record<string, string>,
    body = payload,
    secrets = [secret],
    replay = memoryReplayStore(),
    now = NOW,
  ) => verifyWebhook({ secrets, headers, payload: body, toleranceSeconds: 300, replay, scope: 'square-api', now });

  it('imzalı teslimatı kabul eder; aynı teslimat ikinci kez reddedilir (replay)', async () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const headers = signWebhook({ secret, id: 'msg_1', timestamp: T, payload });
    expect(headers[WEBHOOK_HEADERS.signature]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    const replay = memoryReplayStore();
    await expect(verify(headers, payload, [secret], replay)).resolves.toEqual({ id: 'msg_1', timestamp: T });
    expect(await reason(verify(headers, payload, [secret], replay))).toBe('replayed');
    // Aynı kimlik, pencere içinde başka bir zamanla da kabul edilmez.
    const resent = signWebhook({ secret, id: 'msg_1', timestamp: T + 10, payload });
    expect(await reason(verify(resent, payload, [secret], replay, new Date(NOW.getTime() + 10_000)))).toBe('replayed');
  });

  it('zaman penceresi, gövde, sır ve başlıklar denetlenir', async () => {
    const at = (timestamp: number) => signWebhook({ secret, id: `msg_${timestamp}`, timestamp, payload });
    expect(await reason(verify(at(T - 301)))).toBe('timestamp_out_of_range');
    expect(await reason(verify(at(T + 301)))).toBe('timestamp_out_of_range');
    expect(await reason(verify(at(T - 300)))).toBe('kabul edildi');
    expect(await reason(verify(at(T), `${payload} `))).toBe('invalid_signature');
    expect(await reason(verify(at(T), payload, [generateWebhookSecret()]))).toBe('invalid_signature');
    expect(await reason(verify({ [WEBHOOK_HEADERS.id]: 'x' }))).toBe('missing_headers');
    expect(await reason(verify({ ...at(T), [WEBHOOK_HEADERS.timestamp]: '2026-10-06' }))).toBe('invalid_timestamp');
    expect(await reason(verify({ ...at(T), [WEBHOOK_HEADERS.signature]: 'v2,abc' }))).toBe('invalid_signature');
  });

  it('sahte imzalı istek kimliği tüketmez; başlık adları büyük-küçük harften bağımsız', async () => {
    const replay = memoryReplayStore();
    const forged = { ...signWebhook({ secret: generateWebhookSecret(), id: 'msg_9', timestamp: T, payload }) };
    expect(await reason(verify(forged, payload, [secret], replay))).toBe('invalid_signature');
    expect(replay.size()).toBe(0);
    const real = signWebhook({ secret, id: 'msg_9', timestamp: T, payload });
    const upper = Object.fromEntries(Object.entries(real).map(([k, v]) => [k.toUpperCase(), v]));
    expect(await reason(verify(upper, payload, [secret], replay))).toBe('kabul edildi');
  });

  it('sır döndürme: eski ve yeni sır birlikte; başlıkta birden çok imza', async () => {
    const next = generateWebhookSecret();
    const oldSigned = signWebhook({ secret, id: 'msg_old', timestamp: T, payload });
    expect(await reason(verify(oldSigned, payload, [next, secret]))).toBe('kabul edildi');
    const both = signWebhook({ secret: next, id: 'msg_both', timestamp: T, payload });
    const multi = {
      ...both,
      [WEBHOOK_HEADERS.signature]: `${signWebhook({ secret, id: 'msg_both', timestamp: T, payload })[WEBHOOK_HEADERS.signature]} ${both[WEBHOOK_HEADERS.signature]}`,
    };
    expect(await reason(verify(multi, payload, [next]))).toBe('kabul edildi');
  });

  it('sır biçimini doğrular', async () => {
    expect(() => signWebhook({ secret: 'düz-sır', id: 'm', timestamp: T, payload })).toThrow(/whsec_/);
    expect(() => signWebhook({ secret: 'whsec_AAAA', id: 'm', timestamp: T, payload })).toThrow(/24 bayt/);
    await expect(verify(signWebhook({ secret, id: 'm', timestamp: T, payload }), payload, [])).rejects.toThrow(
      /en az bir/,
    );
  });
});
