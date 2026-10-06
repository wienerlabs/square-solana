// Sahte RPC'nin bilmediği yöntem JSON-RPC hatası döner; bilinmeyen mint hesabı yoktur.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeSolanaRpc, type FakeSolanaRpc } from './solana-rpc.js';

let rpc: FakeSolanaRpc;
beforeAll(async () => {
  rpc = await startFakeSolanaRpc();
});
afterAll(async () => {
  await rpc.close();
});

const call = async (method: string, params: unknown[] = []) =>
  (await (
    await fetch(rpc.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  ).json()) as { result?: { value: unknown }; error?: { code: number } };

describe('startFakeSolanaRpc', () => {
  it('bilinmeyen yöntemde -32601', async () => {
    expect((await call('getBalance')).error?.code).toBe(-32601);
  });

  it('kayıtsız hesap null, kayıtlı mint 82 bayt', async () => {
    expect((await call('getAccountInfo', ['11111111111111111111111111111111'])).result?.value).toBeNull();
    rpc.addMint('So11111111111111111111111111111111111111112', 9);
    const value = (await call('getAccountInfo', ['So11111111111111111111111111111111111111112'])).result?.value as {
      data: [string, string];
    };
    expect(Buffer.from(value.data[0], 'base64')).toHaveLength(82);
    expect(Buffer.from(value.data[0], 'base64')[44]).toBe(9);
  });
});
