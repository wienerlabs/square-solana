// Sponsorlu işlem servisinin istemcisi (FE-21): zarfın doğrulanması, oturum başlığı, ret sebebinin metni.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FeePayerError, SPONSOR_REJECTION_TEXT, feePayerApi, sponsorErrorText, unwrapSponsor } from '@/lib/fee-payer';

const BASE = 'https://sponsor.square.test';
const SPONSOR = 'Sponsor1111111111111111111111111111111111111';
const meta = { requestId: 'req-1', page: null, limit: null, total: null };
const ok = (data: unknown) => ({ success: true, data, error: null, meta });
const failure = (code: string, message: string, details: Record<string, unknown> | null, programError = null) => ({
  success: false,
  data: null,
  error: { code, message, programError, details },
  meta,
});

/** İstekleri kaydeden ve verilen gövdeyle yanıtlayan fetch. */
function server(respond: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const send = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, init });
    const { status, body } = respond(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': typeof body === 'string' ? 'text/html' : 'application/json' },
    });
  }) as typeof fetch;
  return { seen, send };
}

const INFO = {
  sponsor: SPONSOR,
  allowedInstructions: ['escrow:create_job', 'squads:vault_transaction_execute'],
  maxComputeUnitPrice: '100000',
  maxComputeUnitLimit: 1_400_000,
  maxLamportsPerTx: '10000000',
  userDailyLamports: '50000000',
};

const RESULT = {
  transaction: 'AQ==',
  signature: '5sig',
  submitted: true,
  feeLamports: '10000',
  rentLamports: '2039280',
  computeUnits: 41_234,
  computeUnitLimit: 50_000,
  computeUnitPrice: '0',
  instructions: ['squads:vault_transaction_execute', 'vault>escrow:create_job'],
  dailySpentLamports: '2049280',
  dailyLimitLamports: '50000000',
};

describe('feePayerApi', () => {
  it('sends the session, reads info and usage, and posts the transaction to sponsor', async () => {
    const { seen, send } = server((url) => {
      if (url.endsWith('/v1/sponsor/info')) return { status: 200, body: ok(INFO) };
      if (url.endsWith('/v1/sponsor/usage')) {
        return {
          status: 200,
          body: ok({ day: '2026-10-07', spentLamports: '0', limitLamports: '50000000', transactions: 0 }),
        };
      }
      return { status: 200, body: ok(RESULT) };
    });
    const api = feePayerApi(BASE, 'sqs_token', send);
    expect(unwrapSponsor(await api.info())).toEqual(INFO);
    expect(unwrapSponsor(await api.usage())).toMatchObject({ day: '2026-10-07', transactions: 0 });
    expect(unwrapSponsor(await api.sponsor({ transaction: 'AQ==', submit: true }))).toEqual(RESULT);

    expect(seen.map(({ url, init }) => [url, init.method])).toEqual([
      [`${BASE}/v1/sponsor/info`, 'GET'],
      [`${BASE}/v1/sponsor/usage`, 'GET'],
      [`${BASE}/v1/sponsor`, 'POST'],
    ]);
    for (const { init } of seen) {
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sqs_token');
    }
    expect((seen[2]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(seen[2]!.init.body))).toEqual({ transaction: 'AQ==', submit: true });
  });

  it('rejects a body that is not the envelope or does not match the schema', async () => {
    const html = feePayerApi(BASE, 's', server(() => ({ status: 502, body: '<html>bad gateway</html>' })).send);
    await expect(html.info()).rejects.toMatchObject({ name: 'FeePayerError', code: 'invalid_response' });
    const wrong = feePayerApi(BASE, 's', server(() => ({ status: 200, body: ok({ sponsor: 42 }) })).send);
    await expect(wrong.info()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('rejections', () => {
  it('carry the policy reason and read as the UI text', async () => {
    const { send } = server(() => ({
      status: 403,
      body: failure('forbidden', 'program izin listesinde değil', { reason: 'program_not_allowed' }),
    }));
    const envelope = await feePayerApi(BASE, 's', send).sponsor({ transaction: 'AQ==', submit: true });
    let caught: unknown;
    try {
      unwrapSponsor(envelope);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FeePayerError);
    expect(caught).toMatchObject({ code: 'forbidden', reason: 'program_not_allowed' });
    expect(sponsorErrorText(caught)).toBe(SPONSOR_REJECTION_TEXT['program_not_allowed']);
  });

  it('name the program error of a failed simulation with its IDL message', () => {
    const error = new FeePayerError('simulation_failed', 'simülasyon başarısız', 'simulation_failed', {
      program: 'escrow',
      code: 6000,
      name: 'Unauthorized',
    });
    const text = sponsorErrorText(error);
    expect(text.startsWith(SPONSOR_REJECTION_TEXT['simulation_failed']!)).toBe(true);
    expect(text).toContain('Unauthorized (escrow, 6000)');
  });

  it('fall back to the service message for an unknown reason and explain an unreachable service', () => {
    expect(sponsorErrorText(new FeePayerError('internal_error', 'beklenmeyen hata', null, null))).toBe(
      'beklenmeyen hata',
    );
    expect(sponsorErrorText(new TypeError('Failed to fetch'))).toBe('The sponsor service could not be reached.');
  });

  it('cover every reason the service documents', () => {
    // apps/fee-payer/README.md, "Politika" tablosunun ilk sütunu: servisin `error.details.reason` değerleri.
    const readme = readFileSync(new URL('../../fee-payer/README.md', import.meta.url), 'utf8');
    const table = readme.slice(readme.indexOf('## Politika'), readme.indexOf('Sponsorun durabileceği'));
    const reasons = table
      .split('\n')
      // Başlık satırı (`reason` | Kural) hariç.
      .filter((line) => line.startsWith('| `') && !line.startsWith('| `reason`'))
      .flatMap((line) => [...line.split('|')[1]!.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!));
    expect(reasons.length).toBeGreaterThan(20);
    expect(Object.keys(SPONSOR_REJECTION_TEXT).sort()).toEqual([...new Set(reasons)].sort());
  });
});
