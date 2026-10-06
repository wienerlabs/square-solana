import { describe, expect, it } from 'vitest';
import { isSecretKey, redact, redactString, REDACTED } from '../src/redact.js';

// Testlerin gizli değerleri: biçimleri gerçek anahtarlarla aynı, kendileri hiçbir hesaba ait değil.
const KEYPAIR_BYTES = Array.from({ length: 64 }, (_, i) => (i * 7) % 256);
const TX_SIGNATURE = '5'.repeat(44) + 'J'.repeat(44);
// Kısa gövde: anahtar değil, yalnızca bloğun biçimi (sır tarayıcısının kuralı 64+ karakterlik gövde arar).
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADAN\n-----END PRIVATE KEY-----';

describe('isSecretKey', () => {
  it('gizli alan adlarını büyük-küçük harf ve ayırıcıdan bağımsız tanır', () => {
    for (const key of [
      'password',
      'apiKey',
      'api_key',
      'x-api-key',
      'Authorization',
      'cookie',
      'secretKey',
      'privateKey',
      'keypair',
      'mnemonic',
      'seed_phrase',
      'salt',
      'policySalt',
      'witness',
      'STRIPE_WEBHOOK_SECRET',
      'MPP_AUTHORITY_KEYPAIR_BASE58',
      'x-mpp-credential',
      'refreshToken',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ['signature', 'publicKey', 'job', 'amount', 'requestId', 'route', 'seeds', 'status']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactString', () => {
  it('dizedeki gizli biçimleri maskeler, geri kalanını korur', () => {
    expect(redactString('Authorization: Bearer eyJhbGciOi.abc-def_123')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString('Basic dXNlcjpwYXNz')).toBe(`Basic ${REDACTED}`);
    expect(redactString('postgres://square:hunter2@db.internal:5432/square')).toBe(
      `postgres://${REDACTED}@db.internal:5432/square`,
    );
    expect(redactString('https://rpc.example/?api-key=0123abcd&commitment=confirmed')).toBe(
      `https://rpc.example/?api-key=${REDACTED}&commitment=confirmed`,
    );
    expect(redactString('stripe sk_live_51Habc and sk_test_4eC39 rk_test_9x whsec_f00')).toBe(
      `stripe ${REDACTED} and ${REDACTED} ${REDACTED} ${REDACTED}`,
    );
    expect(redactString(`key: ${PEM} end`)).toBe(`key: ${REDACTED} end`);
    expect(redactString(`file ${JSON.stringify(KEYPAIR_BYTES)}`)).toBe(`file ${REDACTED}`);
  });

  it('işlem imzasını ve açık anahtarı maskelemez', () => {
    const text = `tx ${TX_SIGNATURE} by 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`;
    expect(redactString(text)).toBe(text);
  });
});

describe('redact', () => {
  it('gizli adlı alanları, iç içe değerleri ve bayt dizilerini maskeler; girdiyi değiştirmez', () => {
    const input = {
      requestId: 'r-1',
      signature: TX_SIGNATURE,
      config: { databaseUrl: 'postgres://u:p@h/db', stripe: { secretKey: 'sk_live_x', currency: 'usd' } },
      headers: [{ authorization: 'Bearer abc' }, { accept: 'application/json' }],
      secretKey: Uint8Array.from(KEYPAIR_BYTES),
      bytes: new Uint8Array(32),
      buffer: new ArrayBuffer(4),
      keypairFile: KEYPAIR_BYTES,
      amount: 25_000_000n,
      at: new Date('2026-10-06T00:00:00Z'),
      payee: { toBase58: () => '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' },
      list: [1, 2, 3],
      fn: function check() {},
      symbol: Symbol('s'),
      empty: null,
      flag: true,
    };
    const snapshot = JSON.stringify({ ...input, amount: input.amount.toString() });
    expect(redact(input)).toEqual({
      requestId: 'r-1',
      signature: TX_SIGNATURE,
      config: { databaseUrl: `postgres://${REDACTED}@h/db`, stripe: { secretKey: REDACTED, currency: 'usd' } },
      headers: [{ authorization: REDACTED }, { accept: 'application/json' }],
      secretKey: REDACTED,
      bytes: '[bytes:32]',
      buffer: '[bytes:4]',
      keypairFile: REDACTED,
      amount: '25000000',
      at: '2026-10-06T00:00:00.000Z',
      payee: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      list: [1, 2, 3],
      fn: expect.stringContaining('function check'),
      symbol: 'Symbol(s)',
      empty: null,
      flag: true,
    });
    expect(JSON.stringify({ ...input, amount: input.amount.toString() })).toBe(snapshot);
  });

  it('hatanın mesajını, yığınını ve sebebini maskeler', () => {
    const cause = new Error('connect postgres://admin:s3cret@db/square failed');
    const error = new Error('Stripe rejected sk_test_abc', { cause });
    const out = redact({ error }) as { error: Record<string, unknown> };
    expect(out.error['name']).toBe('Error');
    expect(out.error['message']).toBe(`Stripe rejected ${REDACTED}`);
    expect(String(out.error['stack'])).not.toContain('sk_test_abc');
    expect((out.error['cause'] as Record<string, unknown>)['message']).toBe(
      `connect postgres://${REDACTED}@db/square failed`,
    );
  });

  it('döngüsel ve çok derin değerlerde durur', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop['self'] = loop;
    expect(redact({ loop })).toEqual({ loop: { name: 'loop', self: '[Circular]' } });
    const deep = Array.from({ length: 12 }).reduce<Record<string, unknown>>((inner) => ({ inner }), { leaf: 1 });
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
  });
});
