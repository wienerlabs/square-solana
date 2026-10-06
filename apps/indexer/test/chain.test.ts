import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChain, type Chain } from '../src/chain.js';
import { FixtureChain, startRpcServer, type RpcServer } from './fixtures/rpc-server.js';
import { PROGRAM_IDS, World } from './fixtures/world.js';

let fixture: FixtureChain;
let good: RpcServer;
let bad: RpcServer;
let world: World;
let chain: Chain;
const failovers: { from: string; reason: string; status?: number }[] = [];

beforeAll(async () => {
  fixture = new FixtureChain();
  good = await startRpcServer(fixture);
  bad = await startRpcServer(fixture);
  bad.failWith = 503;
  world = new World(fixture, good.url);
  chain = createChain({
    urls: [bad.url, good.url],
    timeoutMs: 2_000,
    cooldownMs: 60_000,
    onFailover: (event) => failovers.push(event),
  });
});
afterAll(async () => {
  await good.close();
  await bad.close();
});

describe('zincir okuması', () => {
  it('hata veren uçtan sıradakine geçer', async () => {
    expect(await chain.finalizedSlot()).toBe(fixture.slot);
    expect(failovers[0]).toMatchObject({ reason: 'server_error', status: 503 });
    expect(chain.endpoint()).toBe(new URL(good.url).href);
  });

  it('hesapları 100, durumları 256 imzalık parçalarla okur; en küçük bağlam slot’u döner', async () => {
    const before = fixture.calls.length;
    const addresses = Array.from({ length: 150 }, () => world.key());
    await world.put('escrow', 'job', addresses[120]!, world.sample('escrow', 'job'));
    const snapshot = await chain.accounts(addresses, fixture.slot);
    expect(snapshot.slot).toBe(fixture.slot);
    expect(snapshot.accounts.filter(Boolean)).toHaveLength(1);
    expect(snapshot.accounts[120]?.owner.equals(PROGRAM_IDS.escrow)).toBe(true);
    expect(await chain.accounts([], fixture.slot)).toEqual({ slot: fixture.slot, accounts: [] });
    await expect(chain.accounts(addresses.slice(0, 1), fixture.slot + 1)).rejects.toThrow();

    const statuses = await chain.signatureStatuses(Array.from({ length: 300 }, (_, i) => `${i}`.padStart(64, '1')));
    expect(statuses).toHaveLength(300);
    const calls = fixture.calls.slice(before);
    expect(calls.filter((c) => c === 'getMultipleAccounts')).toHaveLength(2 + 1);
    expect(calls.filter((c) => c === 'getSignatureStatuses')).toHaveLength(2);
  });

  it("tx'in yazılabilir hesapları (lookup table dahil), başarısız tx ve bilinmeyen imza", async () => {
    const [writable, loaded] = [world.key(), world.key()];
    const signature = world.tx({ program: 'verifier', writable: [writable], loaded: [loaded] });
    const tx = (await chain.transaction(signature))!;
    expect(tx.failed).toBe(false);
    expect(tx.writableAccounts.map((key) => key.toBase58())).toEqual([
      fixture.txs.at(-1)!.keys[0]!.pubkey,
      writable.toBase58(),
      loaded.toBase58(),
    ]);
    expect(tx.logs[0]).toBe(`Program ${PROGRAM_IDS.verifier.toBase58()} invoke [1]`);
    const failed = world.tx({ program: 'escrow', err: { InstructionError: [0, { Custom: 1 }] } });
    expect((await chain.transaction(failed))!.failed).toBe(true);
    expect(await chain.transaction('1'.repeat(64))).toBeNull();
  });

  it('program hesapları discriminator filtresiyle; imzalar yeniden eskiye', async () => {
    const job = world.key();
    await world.put('escrow', 'job', job, world.sample('escrow', 'job'));
    const discriminator = Uint8Array.from(
      world.programs.escrow.idl.accounts!.find((x) => x.name === 'job')!.discriminator,
    );
    const jobs = await chain.programAccounts(PROGRAM_IDS.escrow, discriminator);
    expect(jobs.accounts.map((entry) => entry.pubkey.toBase58())).toContain(job.toBase58());
    expect(jobs.accounts.every((entry) => entry.account.data.subarray(0, 8).equals(Buffer.from(discriminator)))).toBe(
      true,
    );

    const first = world.tx({ program: 'policy' });
    const second = world.tx({ program: 'policy' });
    const listed = await chain.signatures(PROGRAM_IDS.policy, { limit: 10 });
    expect(listed.slice(0, 2).map((s) => s.signature)).toEqual([second, first]);
    expect((await chain.signatures(PROGRAM_IDS.policy, { limit: 10, until: first })).map((s) => s.signature)).toEqual([
      second,
    ]);
    expect((await chain.signatures(PROGRAM_IDS.policy, { limit: 1, before: second }))[0]!.signature).toBe(first);
    expect(await chain.signatures(new PublicKey(new Uint8Array(32).fill(3)), { limit: 5 })).toEqual([]);
  });
});
