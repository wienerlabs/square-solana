// @vitest-environment jsdom
// Square API oturumu (FE-17): cüzdan yalnızca kendi adına verilmiş bir giriş mesajını imzalar, imza base58
// gönderilir, oturum bu sekmede süresi dolana kadar durur; API hatalarının okunur metni. API, SDK istemcisine
// verilen bir `fetch` ile taklit edilir.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { utils } from '@anchor-lang/core';
import { Keypair } from '@solana/web3.js';
import { ApiClientError, createApiClient } from '@squaresdk/solana-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  apiErrorText,
  ApiRequestError,
  forgetSession,
  readStoredSession,
  signInMessageProblem,
  signInWithWallet,
  storeSession,
} from '@/lib/api-session';
import { disputeHint } from '@/lib/dispute';

const API = 'https://api.square.example';
const wallet = Keypair.generate();
const address = wallet.publicKey.toBase58();
const NONCE = 'bm9uY2Utbm9uY2Utbm9uY2U';
// Cüzdanın Ed25519 anahtarı Node'un crypto'suyla (JWK): imza gerçek, API tarafı da gerçekten doğrular.
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const jwk = { kty: 'OKP', crv: 'Ed25519', x: b64url(wallet.publicKey.toBytes()) };
const privateKey = createPrivateKey({ key: { ...jwk, d: b64url(wallet.secretKey.slice(0, 32)) }, format: 'jwk' });
const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
const signMessage = async (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, privateKey));
const meta = { requestId: 'r', page: null, limit: null, total: null };
const ok = (data: unknown) => ({ success: true, data, error: null, meta });
const message = (forWallet = address, nonce = NONCE) =>
  [
    'api.square.example wants you to sign in with your Solana account:',
    forWallet,
    '',
    'Sign in to Square.',
    '',
    `Nonce: ${nonce}`,
    'Issued At: 2026-10-06T10:00:00.000Z',
    'Expiration Time: 2026-10-06T10:05:00.000Z',
  ].join('\n');

/** Challenge'ı veren ve imzayı gerçekten doğrulayan sahte API. */
function fakeApi(challengeMessage = message()) {
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    bodies.push(body);
    if (url.endsWith('/v1/auth/challenge'))
      return Response.json(ok({ nonce: NONCE, message: challengeMessage, expiresAt: 1_790_000_300 }));
    const signature = utils.bytes.bs58.decode(String(body.signature));
    const valid = verify(null, new TextEncoder().encode(challengeMessage), publicKey, signature);
    return valid
      ? Response.json(ok({ token: 'sqs_test', wallet: body.wallet, expiresAt: 1_790_003_600 }))
      : Response.json(
          {
            success: false,
            data: null,
            error: { code: 'unauthorized', message: 'imza geçersiz', programError: null, details: null },
            meta,
          },
          { status: 401 },
        );
  };
  return { api: createApiClient({ baseUrl: API, fetch }), bodies };
}

beforeEach(() => window.sessionStorage.clear());

describe('sign-in', () => {
  it('signs the API’s message for this wallet and opens a session', async () => {
    const { api, bodies } = fakeApi();
    const session = await signInWithWallet(api, address, signMessage);
    expect(session).toEqual({ token: 'sqs_test', wallet: address, expiresAt: 1_790_003_600 });
    expect(bodies[1]).toMatchObject({ wallet: address, nonce: NONCE });
  });

  it('refuses to sign a message for another wallet or another nonce', async () => {
    expect(signInMessageProblem(message(), address, NONCE)).toBeNull();
    expect(signInMessageProblem(message(Keypair.generate().publicKey.toBase58()), address, NONCE)).toMatch(
      /another wallet/,
    );
    expect(signInMessageProblem(message(address, 'other-nonce-value-1'), address, NONCE)).toMatch(/nonce/);
    expect(signInMessageProblem('Transfer 100 USDC', address, NONCE)).toMatch(/not a sign-in message/);
    let signed = false;
    const { api } = fakeApi(message(Keypair.generate().publicKey.toBase58()));
    await expect(
      signInWithWallet(api, address, async (bytes) => {
        signed = true;
        return signMessage(bytes);
      }),
    ).rejects.toThrow(/another wallet/);
    expect(signed).toBe(false);
  });

  it('keeps the session in this tab until it expires', () => {
    const session = { token: 'sqs_x', wallet: address, expiresAt: 2_000 };
    storeSession(API, session);
    expect(readStoredSession(API, address, 1_000)).toEqual(session);
    // Bitişe 30 saniyeden az kala geçersiz.
    expect(readStoredSession(API, address, 1_975)).toBeNull();
    expect(readStoredSession('https://other.example', address, 1_000)).toBeNull();
    expect(readStoredSession(API, Keypair.generate().publicKey.toBase58(), 1_000)).toBeNull();
    forgetSession(API, address);
    expect(readStoredSession(API, address, 1_000)).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });
});

describe('API errors', () => {
  const error = (code: string, programError: unknown = null) =>
    new ApiRequestError({ code, message: 'sunucu mesajı', programError, details: null } as never);

  it('explains the refusal and the program error behind it', () => {
    expect(apiErrorText(error('forbidden'))).toBe('The API does not allow this wallet to do that. (sunucu mesajı)');
    expect(
      apiErrorText(
        error('simulation_failed', { program: 'escrow', code: 6025, name: 'ResolutionMismatch' }),
        disputeHint,
      ),
    ).toBe(
      'The transaction fails in simulation. ResolutionMismatch (escrow, 6025): The first vote set the decision; later votes must match it exactly.',
    );
    expect(apiErrorText(new ApiClientError(502, 'bad gateway'))).toBe('The API answered unexpectedly (HTTP 502).');
    expect(apiErrorText(new TypeError('Failed to fetch'))).toBe('The Square API could not be reached.');
  });
});
