import { createPublicKey, verify } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import type { SquareApi } from '@squaresdk/solana-sdk';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { createScopedApiKey, signMessage, type ApiAuth } from '../src/auth.js';

const ok = <T>(data: T) => ({ success: true as const, data, error: null, meta: { requestId: 'r' } });
const failed = (code: string) => ({
  success: false as const,
  data: null,
  error: { code, message: `${code} mesajı` },
  meta: { requestId: 'r' },
});

function fakeApi(overrides: Partial<Record<'challenge' | 'session' | 'key', unknown>> = {}) {
  const calls: { method: string; auth: ApiAuth | undefined; body: unknown }[] = [];
  const api = (auth?: ApiAuth) =>
    ({
      createAuthChallenge: async (body: unknown) => {
        calls.push({ method: 'challenge', auth, body });
        return overrides.challenge ?? ok({ nonce: 'n'.repeat(16), message: 'Sign in to Square.', expiresAt: 1 });
      },
      createSession: async (body: unknown) => {
        calls.push({ method: 'session', auth, body });
        return overrides.session ?? ok({ token: 'sqs_oturum', wallet: 'w', expiresAt: 1 });
      },
      createApiKey: async (body: unknown) => {
        calls.push({ method: 'key', auth, body });
        return overrides.key ?? ok({ apiKey: {}, secret: 'sqk_' + 'k'.repeat(40) });
      },
    }) as unknown as SquareApi;
  return { api, calls };
}

describe('API kimliği', () => {
  it('mesaj cüzdanın Ed25519 anahtarıyla imzalanır (base58)', () => {
    const keypair = Keypair.generate();
    const signature = bs58.decode(signMessage(keypair, 'Sign in to Square.'));
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(keypair.publicKey.toBytes()).toString('base64url') },
      format: 'jwk',
    });
    expect(verify(null, Buffer.from('Sign in to Square.'), publicKey, signature)).toBe(true);
    expect(verify(null, Buffer.from('başka mesaj'), publicKey, signature)).toBe(false);
  });

  it('oturum açılır ve kapsamlı anahtar oturumla oluşturulur', async () => {
    const keypair = Keypair.generate();
    const { api, calls } = fakeApi();
    expect(await createScopedApiKey(api, keypair, ['prove'], 'e2e')).toBe('sqk_' + 'k'.repeat(40));
    expect(calls.map(({ method, auth }) => [method, auth])).toEqual([
      ['challenge', undefined],
      ['session', undefined],
      ['key', { session: 'sqs_oturum' }],
    ]);
    expect(calls[1]?.body).toMatchObject({ wallet: keypair.publicKey.toBase58(), nonce: 'n'.repeat(16) });
    expect(calls[2]?.body).toEqual({ label: 'e2e', scopes: ['prove'] });
  });

  it('her adımın hatası adıyla döner', async () => {
    const keypair = Keypair.generate();
    await expect(
      createScopedApiKey(fakeApi({ challenge: failed('rate_limited') }).api, keypair, ['prove'], 'e2e'),
    ).rejects.toThrow('oturum isteği: rate_limited');
    await expect(
      createScopedApiKey(fakeApi({ session: failed('unauthorized') }).api, keypair, ['prove'], 'e2e'),
    ).rejects.toThrow('oturum: unauthorized');
    await expect(
      createScopedApiKey(fakeApi({ key: failed('invalid_input') }).api, keypair, ['prove'], 'e2e'),
    ).rejects.toThrow('API anahtarı: invalid_input');
  });
});
