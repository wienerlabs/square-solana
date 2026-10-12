import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../src/app/healthz/route';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('GET /healthz', () => {
  it('answers 200 when the network configuration is valid', async () => {
    process.env.SQUARE_SOLANA_CLUSTER = 'devnet';
    process.env.SQUARE_SOLANA_RPC_URL = 'https://rpc.example.org/?api-key=secret';
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('answers 503 with the reasons, never the values, when it is not', async () => {
    delete process.env.SQUARE_SOLANA_CLUSTER;
    process.env.SQUARE_SOLANA_RPC_URL = 'http://rpc.example.org/?api-key=secret';
    const res = GET();
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(JSON.parse(body).errors).toEqual([
      'SQUARE_SOLANA_CLUSTER is not set',
      'SQUARE_SOLANA_RPC_URL must use https unless SQUARE_SOLANA_CLUSTER is localnet or the host is local (localhost, 127.0.0.1, [::1])',
    ]);
    expect(body).not.toContain('secret');
  });
});
