import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actionMessage,
  bodySha256,
  SIGNED_ACTION_HEADERS,
  SignedActionError,
  signAction,
  signedFetch,
  verifySignedAction,
  type MessageSigner,
} from '../src/signed-action.js';
import { memoryReplayStore } from './memory-stores.js';

/** Gerçek Ed25519 anahtarıyla imzalayan cüzdan (test anahtarı, her çalışmada yeni). */
function wallet(): MessageSigner {
  const secret = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(secret);
  return {
    publicKey: { toBase58: () => bs58.encode(publicKey) },
    signMessage: async (message) => ed25519.sign(message, secret),
  };
}

const DOMAIN = 'app.square.example';
const NOW = new Date('2026-10-06T09:00:00.000Z');

interface Captured {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const captured: Captured[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    captured.push({
      method: req.method!,
      path: req.url!,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    res.end('ok');
  });
});
let base: string;
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
    return 'kabul edildi';
  } catch (error) {
    if (error instanceof SignedActionError) return error.reason;
    throw error;
  }
}

describe('signed actions', () => {
  it('mesaj alan adını, cüzdanı, eylemi, gövde özetini, nonce ve zamanı gösterir', () => {
    const message = actionMessage({
      domain: DOMAIN,
      wallet: 'Wallet111',
      action: 'POST /v1/deliveries',
      bodySha256: bodySha256('{}'),
      nonce: 'n1',
      issuedAt: NOW.toISOString(),
    });
    expect(message).toBe(
      [
        `${DOMAIN} wants you to sign a request with your Solana account:`,
        'Wallet111',
        '',
        'Action: POST /v1/deliveries',
        `Body SHA-256: ${bodySha256('{}')}`,
        'Nonce: n1',
        'Issued At: 2026-10-06T09:00:00.000Z',
      ].join('\n'),
    );
    expect(bodySha256(undefined)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('signedFetch isteği imzalar; sunucu doğrular; aynı imza ikinci kez reddedilir', async () => {
    const signer = wallet();
    const send = signedFetch({ signer, domain: DOMAIN });
    const body = JSON.stringify({ job: 'JobPda111', uri: 'ipfs://delivery' });
    await send(`${base}/v1/deliveries?draft=1`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    });
    const request = captured.at(-1)!;
    expect(request.headers['content-type']).toBe('application/json');
    const replay = memoryReplayStore();
    const verify = (
      overrides: Partial<{ path: string; body: string; method: string; domain: string; now: Date }> = {},
    ) =>
      verifySignedAction({
        headers: request.headers,
        domain: overrides.domain ?? DOMAIN,
        method: overrides.method ?? request.method,
        path: overrides.path ?? request.path,
        body: overrides.body ?? request.body,
        maxAgeSeconds: 300,
        clockSkewSeconds: 30,
        replay,
        now: overrides.now ?? new Date(),
      });
    // Değiştirilmiş istekler imzayı tutmaz ve nonce'u tüketmez.
    expect(await reason(verify({ body: `${body} ` }))).toBe('invalid_signature');
    expect(await reason(verify({ path: '/v1/deliveries' }))).toBe('invalid_signature');
    expect(await reason(verify({ method: 'PUT' }))).toBe('invalid_signature');
    expect(await reason(verify({ domain: 'evil.example' }))).toBe('invalid_signature');
    await expect(verify()).resolves.toEqual({ wallet: signer.publicKey.toBase58() });
    expect(await reason(verify())).toBe('replayed');
  });

  it('süre ve başlıklar denetlenir', async () => {
    const signer = wallet();
    const url = new URL('https://api.square.example/v1/claims/buy');
    const headers = await signAction({ signer, domain: DOMAIN, method: 'post', url, body: 'b', now: NOW });
    const verify = (h: Record<string, string>, now: Date) =>
      verifySignedAction({
        headers: h,
        domain: DOMAIN,
        method: 'POST',
        path: '/v1/claims/buy',
        body: 'b',
        maxAgeSeconds: 300,
        clockSkewSeconds: 30,
        replay: memoryReplayStore(),
        now,
      });
    expect(await reason(verify(headers, new Date(NOW.getTime() + 301_000)))).toBe('expired');
    expect(await reason(verify(headers, new Date(NOW.getTime() - 31_000)))).toBe('expired');
    expect(await reason(verify(headers, new Date(NOW.getTime() + 300_000)))).toBe('kabul edildi');
    const { [SIGNED_ACTION_HEADERS.nonce]: _, ...noNonce } = headers;
    expect(await reason(verify(noNonce, NOW))).toBe('missing_headers');
    expect(await reason(verify({ ...headers, [SIGNED_ACTION_HEADERS.wallet]: 'kısa' }, NOW))).toBe('invalid_wallet');
    expect(await reason(verify({ ...headers, [SIGNED_ACTION_HEADERS.issuedAt]: 'dün' }, NOW))).toBe(
      'invalid_timestamp',
    );
    expect(await reason(verify({ ...headers, [SIGNED_ACTION_HEADERS.signature]: 'xyz' }, NOW))).toBe(
      'invalid_signature',
    );
    await expect(
      verifySignedAction({
        headers,
        domain: DOMAIN,
        method: 'POST',
        path: 'v1/x',
        maxAgeSeconds: 1,
        clockSkewSeconds: 1,
        replay: memoryReplayStore(),
      }),
    ).rejects.toThrow(/ile başlamalı/);
  });

  it('akış gövdesi imzalanamaz', async () => {
    const send = signedFetch({ signer: wallet(), domain: DOMAIN });
    await expect(send(`${base}/x`, { method: 'POST', body: new Blob(['x']) })).rejects.toThrow(/dize ya da Uint8Array/);
  });
});
