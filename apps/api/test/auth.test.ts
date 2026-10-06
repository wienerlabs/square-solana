// auth uçları: challenge, oturum, API anahtarları; yetkisiz erişim ve hız sınırı.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { loadOpenApi } from '../src/openapi.js';
import { login, sign } from './fixtures/login.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { wallet } from './fixtures/world.js';

let stack: Stack;
let now = Date.parse('2026-10-06T12:00:00Z');

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL), clock: () => now });
});
afterAll(() => stack.close());
beforeEach(async () => {
  await truncate(stack.db);
  now = Date.parse('2026-10-06T12:00:00Z');
});

describe('oturum', () => {
  it('challenge okunabilir mesajdır; imzalı mesajla oturum açılır ve kapatılır', async () => {
    const user = wallet();
    const challenge = await stack.api().createAuthChallenge({ wallet: user.address });
    if (!challenge.success) throw new Error('challenge');
    expect(challenge.data.message.split('\n')).toEqual([
      'app.square.test wants you to sign in with your Solana account:',
      user.address,
      '',
      'Sign in to Square.',
      '',
      `Nonce: ${challenge.data.nonce}`,
      'Issued At: 2026-10-06T12:00:00.000Z',
      'Expiration Time: 2026-10-06T12:05:00.000Z',
    ]);
    expect(challenge.data.expiresAt).toBe(Date.parse('2026-10-06T12:05:00Z') / 1000);
    const session = await stack.api().createSession({
      wallet: user.address,
      nonce: challenge.data.nonce,
      signature: sign(user, challenge.data.message),
    });
    if (!session.success) throw new Error(session.error.message);
    expect(session.data).toMatchObject({ wallet: user.address, expiresAt: Date.parse('2026-10-06T13:00:00Z') / 1000 });
    expect(session.data.token).toMatch(/^sqs_[A-Za-z0-9_-]{43}$/);
    const authed = stack.api({ session: session.data.token });
    expect((await authed.listApiKeys()).success).toBe(true);
    await authed.deleteSession();
    expect(await authed.listApiKeys()).toMatchObject({ success: false, error: { code: 'unauthorized' } });
    // Belirtecin kendisi saklanmaz.
    const stored = await stack.db.session.findFirstOrThrow();
    expect(JSON.stringify(stored)).not.toContain(session.data.token);
  });

  it('yanlış imza, başka cüzdan, kullanılmış ve süresi dolmuş challenge oturum açmaz', async () => {
    const user = wallet();
    const other = wallet();
    const api = stack.api();
    const challenge = await api.createAuthChallenge({ wallet: user.address });
    if (!challenge.success) throw new Error('challenge');
    const { nonce, message } = challenge.data;
    const attempt = (body: { wallet: string; signature: string; nonce?: string }) =>
      api.createSession({ nonce, ...body });
    expect(await attempt({ wallet: user.address, signature: sign(other, message) })).toMatchObject({
      error: { code: 'unauthorized', message: 'imza geçersiz' },
    });
    expect(await attempt({ wallet: other.address, signature: sign(other, message) })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(await attempt({ wallet: user.address, signature: '1'.repeat(64) })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect((await attempt({ wallet: user.address, signature: sign(user, message) })).success).toBe(true);
    expect(await attempt({ wallet: user.address, signature: sign(user, message) })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    const late = await api.createAuthChallenge({ wallet: user.address });
    if (!late.success) throw new Error('challenge');
    now += 301_000;
    expect(
      await api.createSession({
        wallet: user.address,
        nonce: late.data.nonce,
        signature: sign(user, late.data.message),
      }),
    ).toMatchObject({ error: { code: 'unauthorized' } });
    expect(
      await api.createSession({ wallet: user.address, nonce: 'x'.repeat(16), signature: '1'.repeat(64) }),
    ).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(await api.createAuthChallenge({ wallet: 'not-a-wallet' })).toMatchObject({
      error: { code: 'invalid_input', details: { issues: [{ path: 'wallet' }] } },
    });
  });

  it('oturumun süresi dolunca belirteç geçersizdir', async () => {
    const token = await login(stack.api(), wallet());
    now += 3_601_000;
    expect(await stack.api({ session: token }).listApiKeys()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});

describe('API anahtarları', () => {
  it('oluşturma, listeleme, iptal; gizli değer yalnızca bir kez döner', async () => {
    const user = wallet();
    const session = stack.api({ session: await login(stack.api(), user) });
    const created = await session.createApiKey({ label: 'agent runtime', scopes: ['tx:prepare', 'read', 'read'] });
    if (!created.success) throw new Error(created.error.message);
    expect(created.data.secret).toMatch(/^sqk_[A-Za-z0-9_-]{43}$/);
    expect(created.data.apiKey).toMatchObject({
      label: 'agent runtime',
      prefix: created.data.secret.slice(0, 12),
      scopes: ['tx:prepare', 'read'],
      lastUsedAt: null,
    });
    const listed = await session.listApiKeys();
    expect(listed.success && listed.data).toEqual([created.data.apiKey]);
    expect(JSON.stringify(listed)).not.toContain(created.data.secret);

    // Anahtarla okuma kullanım zamanını yazar; anahtar oturum uçlarına giremez.
    const keyed = stack.api({ apiKey: created.data.secret });
    expect((await keyed.listJobs()).success).toBe(true);
    const used = await session.listApiKeys();
    expect(used.success && used.data[0]!.lastUsedAt).toBe(now / 1000);
    expect(await keyed.listApiKeys()).toMatchObject({ error: { code: 'unauthorized' } });

    // Başkasının anahtarı ve bilinmeyen kimlik bulunmaz.
    const stranger = stack.api({ session: await login(stack.api(), wallet()) });
    await expect(stranger.deleteApiKey(created.data.apiKey.id)).rejects.toMatchObject({ status: 404 });
    await expect(session.deleteApiKey('not-a-uuid')).rejects.toMatchObject({ status: 404 });
    await session.deleteApiKey(created.data.apiKey.id);
    expect(await session.listApiKeys()).toMatchObject({ data: [] });
    expect(await keyed.listJobs()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await session.createApiKey({ label: '', scopes: [] })).toMatchObject({ error: { code: 'invalid_input' } });
  });
});

describe('yetkisiz erişim', () => {
  it('kimliksiz, geçersiz kimlikli ve iki kimlikli istekler', async () => {
    const anonymous = stack.api();
    expect(await anonymous.listApiKeys()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await anonymous.createApiKey({ label: 'x', scopes: ['read'] })).toMatchObject({
      error: { code: 'unauthorized' },
    });
    await expect(anonymous.deleteApiKey('x')).rejects.toMatchObject({ status: 401 });
    await expect(anonymous.deleteSession()).rejects.toMatchObject({ status: 401 });
    // Herkese açık uçta da geçersiz kimlik reddedilir.
    expect(await stack.api({ session: 'sqs_forged' }).listJobs()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await stack.api({ session: 'not-a-session' }).listJobs()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await stack.api({ apiKey: 'sqk_forged' }).listJobs()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await stack.api({ apiKey: 'forged' }).listJobs()).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await stack.api({ session: 'a', apiKey: 'b' }).listJobs()).toMatchObject({
      error: { code: 'invalid_input' },
    });
    const malformed = await fetch(`${stack.url}/v1/api-keys`, { headers: { authorization: 'Basic abc' } });
    expect(malformed.status).toBe(401);
  });

  it('hız sınırı pencereyi aşan isteği 429 ile reddeder', async () => {
    const limited = await startStack({
      openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL),
      rateLimit: { read: 1_000, write: 2 },
    });
    try {
      const user = wallet();
      for (let i = 0; i < 2; i += 1) {
        expect((await limited.api().createAuthChallenge({ wallet: user.address })).success).toBe(true);
      }
      const response = await fetch(`${limited.url}/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: user.address }),
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(response.headers.get('ratelimit-limit')).toBe('2');
      expect(await response.json()).toMatchObject({ success: false, error: { code: 'rate_limited' } });
      // Okuma sınırı ayrıdır.
      expect((await limited.api().listJobs()).success).toBe(true);
    } finally {
      await limited.close();
    }
  });
});
