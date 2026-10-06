// Travel Rule deposu (Square API'si, sahte fetch): kurumun keypair'iyle meydan okuma imzalanıp oturum açılır, kayıt
// oturumla saklanır ve API'nin commitment'ı döner; oturum süresi dolana kadar yeniden kullanılır, sunucuda düşen
// oturum bir kez yenilenir.
import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair } from '@solana/web3.js';
import type { TravelRuleRecord } from '@squaresdk/solana-types';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { createApiTravelRuleStore } from '../src/travel-rule.js';
import { legalPerson } from './helpers/config.js';

const API = 'https://api.square.test';
const keypair = Keypair.generate();
const job = Keypair.generate().publicKey;
const record: TravelRuleRecord = {
  originator: legalPerson('Kurum A.Ş.', keypair.publicKey.toBase58()),
  beneficiary: legalPerson('Çeviri Ltd.', Keypair.generate().publicKey.toBase58()),
  originatingVasp: null,
  beneficiaryVasp: null,
  amount: '2000000',
  mint: Keypair.generate().publicKey.toBase58(),
};

function fakeApi(options: { rejectFirstPut?: boolean; failChallenge?: boolean; failPut?: boolean } = {}) {
  const log: string[] = [];
  let sessions = 0;
  let puts = 0;
  const envelope = (status: number, data: unknown, error: unknown = null) =>
    new Response(JSON.stringify({ success: status < 400, data, error, meta: { requestId: 'r' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get('authorization');
    log.push(`${init?.method ?? 'GET'} ${url.pathname}${auth ? ` ${auth}` : ''}`);
    const error = (code: string) => ({ code, message: code, programError: null, details: null });
    if (url.pathname === '/v1/auth/challenge') {
      if (options.failChallenge) return envelope(429, null, error('rate_limited'));
      return envelope(200, {
        nonce: 'n'.repeat(16),
        message: `square giriş ${body!.wallet as string}`,
        expiresAt: 2_000,
      });
    }
    if (url.pathname === '/v1/auth/session') {
      const ok = ed25519.verify(
        bs58.decode(body!.signature as string),
        new TextEncoder().encode(`square giriş ${body!.wallet as string}`),
        keypair.publicKey.toBytes(),
      );
      if (!ok) return envelope(401, null, error('unauthorized'));
      sessions += 1;
      return envelope(200, { token: `oturum-${sessions}`, wallet: body!.wallet, expiresAt: 1_000 + 3_600 });
    }
    if (url.pathname === `/v1/jobs/${job.toBase58()}/travel-rule` && init?.method === 'PUT') {
      puts += 1;
      if (options.failPut) return envelope(409, null, error('conflict'));
      if (options.rejectFirstPut && puts === 1) return envelope(401, null, error('unauthorized'));
      expect(body).toEqual({ record });
      return envelope(200, {
        job: job.toBase58(),
        commitment: 'cd'.repeat(32),
        recordDigest: 'ef'.repeat(32),
        storedBy: keypair.publicKey.toBase58(),
        storedAt: 1_000,
        retainUntil: 9_000,
        purgedAt: null,
        chainCommitment: null,
        committed: false,
      });
    }
    return envelope(404, null, error('not_found'));
  };
  return { fetch, log };
}

describe('createApiTravelRuleStore', () => {
  it('oturum açar, kaydı saklar, commitment’ı döner; oturum süresince yeniden kullanır', async () => {
    let now = 1_000;
    const api = fakeApi();
    const store = createApiTravelRuleStore({ baseUrl: API, keypair, fetch: api.fetch, now: () => now });
    expect(await store.put(job, record)).toBe('cd'.repeat(32));
    expect(await store.put(job, record)).toBe('cd'.repeat(32));
    expect(api.log).toEqual([
      'POST /v1/auth/challenge',
      'POST /v1/auth/session',
      `PUT /v1/jobs/${job.toBase58()}/travel-rule Bearer oturum-1`,
      `PUT /v1/jobs/${job.toBase58()}/travel-rule Bearer oturum-1`,
    ]);
    // Süre bitmeden yenilenir.
    now = 1_000 + 3_600 - 10;
    await store.put(job, record);
    expect(api.log.at(-1)).toBe(`PUT /v1/jobs/${job.toBase58()}/travel-rule Bearer oturum-2`);
  });

  it('sunucuda düşen oturum bir kez yenilenir; diğer hatalar kodlarıyla', async () => {
    const api = fakeApi({ rejectFirstPut: true });
    const store = createApiTravelRuleStore({ baseUrl: API, keypair, fetch: api.fetch, now: () => 1_000 });
    expect(await store.put(job, record)).toBe('cd'.repeat(32));
    expect(api.log.filter((line) => line.includes('/auth/session'))).toHaveLength(2);

    const conflict = createApiTravelRuleStore({ baseUrl: API, keypair, fetch: fakeApi({ failPut: true }).fetch });
    await expect(conflict.put(job, record)).rejects.toThrow('Travel Rule kaydı: conflict: conflict');
    const limited = createApiTravelRuleStore({ baseUrl: API, keypair, fetch: fakeApi({ failChallenge: true }).fetch });
    await expect(limited.put(job, record)).rejects.toThrow(/challenge\): rate_limited/);
    const wrongKey = createApiTravelRuleStore({ baseUrl: API, keypair: Keypair.generate(), fetch: fakeApi().fetch });
    await expect(wrongKey.put(job, record)).rejects.toThrow('Travel Rule oturumu: unauthorized: unauthorized');
  });
});
