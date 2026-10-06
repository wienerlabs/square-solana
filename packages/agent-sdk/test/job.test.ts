// Job yürütücüsünün yeniden başlatma ve kesinti yolları (görev bağlamı sahte, zincir benzetim): kabul edilmiş
// job'da kabul tekrarlanmaz, teslim edilmiş job'da yalnızca görev tamamlanır, iptal edilen görevde tx yok.
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { TaskContext } from '@squaresdk/solana-a2a';
import { specHashing } from '@squaresdk/solana-sdk';
import type { JobStatus, Message } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTxSender, toWallet } from '../src/chain.js';
import { assertDiscountBps, claimPrice, createJobExecutor } from '../src/job.js';
import type { ClaimListing, JobRequest } from '../src/types.js';
import { handler, STATS } from './helpers/harness.js';
import { SimChain } from './helpers/sim.js';

const SPEC = { capability: STATS.id, input: 'yeniden başlatma' };

interface Recorded {
  calls: string[];
  context: TaskContext;
  abort: AbortController;
}

function fakeContext(job: PublicKey, parts: Message['parts']): Recorded {
  const calls: string[] = [];
  const abort = new AbortController();
  const record = (name: string) => async (text?: unknown) => {
    calls.push(typeof text === 'string' ? `${name}:${text}` : name);
  };
  const context: TaskContext = {
    taskId: '00000000-0000-4000-8000-000000000001',
    caller: 'api-key:test',
    job: { address: job.toBase58(), status: 'funded', agentRecord: '', institution: '', specHash: '', slot: 1 },
    message: { messageId: 'm', role: 'ROLE_USER', parts },
    signal: abort.signal,
    working: record('working'),
    requireInput: record('requireInput'),
    addArtifact: record('addArtifact'),
    complete: record('complete'),
    fail: record('fail'),
    reject: record('reject'),
  };
  return { calls, context, abort };
}

let sim: SimChain;
const signer = Keypair.generate();
const requests: JobRequest[] = [];
const listings: ClaimListing[] = [];
const errors: unknown[] = [];

function executor(options: { discountBps?: number } = {}) {
  return createJobExecutor({
    client: sim.client,
    sender: createTxSender({ connection: sim.connection(), commitment: 'confirmed', client: sim.client }),
    wallet: toWallet(signer),
    capabilities: [STATS],
    handler: async (request) => {
      requests.push(request);
      await request.progress('çalışıyor');
      return handler(request);
    },
    delivery: {
      upload: async ({ content, contentType }) => ({
        workHash: Buffer.from(await crypto.subtle.digest('SHA-256', content)).toString('hex'),
        deliveryUri: 'ipfs://bafy-teslimat',
        contentType,
        size: content.length,
      }),
    },
    ...(options.discountBps ? { autoListClaim: { discountBps: options.discountBps } } : {}),
    tx: { computeUnitPrice: 1_000n },
    now: () => Math.floor(Date.now() / 1000),
    onError: (error) => errors.push(error),
    onClaimListed: (listing) => listings.push(listing),
  });
}

async function job(status: JobStatus): Promise<PublicKey> {
  const address = Keypair.generate().publicKey;
  await sim.setJob(address, {
    institution: Keypair.generate().publicKey,
    agentRecord: Keypair.generate().publicKey,
    agentWallet: signer.publicKey,
    amount: 4_000_000n,
    specHash: Buffer.from(specHashing.specHash(SPEC)).toString('hex'),
    status,
    deadline: Math.floor(Date.now() / 1000) + 600,
  });
  return address;
}

const specParts: Message['parts'] = [{ data: SPEC as never }];

beforeEach(async () => {
  sim = new SimChain();
  await sim.setConfig();
  requests.length = 0;
  listings.length = 0;
  errors.length = 0;
});

describe('job yürütücüsü', () => {
  it('kabul edilmiş job sürdürülür: accept_job tekrarlanmaz', async () => {
    const address = await job('accepted');
    const { calls, context } = fakeContext(address, specParts);
    await executor().onTask(context);
    expect(sim.sent.map((ix) => ix.name)).toEqual(['submitWork']);
    expect(calls[0]).toBe('working:kabul edilmiş job sürdürülüyor');
    expect(calls).toContain('working:çalışıyor');
    expect(calls).toContain('addArtifact');
    expect(calls.at(-1)).toMatch(/^complete:teslim edildi: submit_work /);
    expect(sim.job(address)!.deliveryUri).toBe('ipfs://bafy-teslimat');
  });

  it('teslim edilmiş job: işleyici çalışmaz, görev tamamlanır, alacak bir kez listelenir', async () => {
    const address = await job('delivered');
    const first = fakeContext(address, specParts);
    await executor({ discountBps: 1_000 }).onTask(first.context);
    expect(first.calls).toEqual(['complete:job zincirde teslim edilmiş (delivered)']);
    expect(requests).toEqual([]);
    expect(sim.sent.map((ix) => ix.name)).toEqual(['listClaim']);
    expect(listings[0]!.price).toBe(3_600_000n);
    // Listeleme zaten varsa tekrarlanmaz.
    await executor({ discountBps: 1_000 }).onTask(fakeContext(address, specParts).context);
    expect(sim.sent).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('ödenmiş job: yalnızca tamamlanır', async () => {
    const address = await job('released');
    const { calls, context } = fakeContext(address, specParts);
    await executor({ discountBps: 1_000 }).onTask(context);
    expect(calls).toEqual(['complete:job zincirde teslim edilmiş (released)']);
    expect(sim.sent).toEqual([]);
  });

  it('iptal edilmiş job ya da kabul edilmiş job’da çözülemeyen capability hata verir', async () => {
    await expect(executor().onTask(fakeContext(await job('cancelled'), specParts).context)).rejects.toThrow(
      'iş yapılamaz',
    );
    const unknown: Message['parts'] = [{ data: { capability: 'yok' } }];
    await expect(executor().onTask(fakeContext(await job('accepted'), unknown).context)).rejects.toThrow(
      'bilinmeyen capability',
    );
    await expect(executor().onTask(fakeContext(Keypair.generate().publicKey, specParts).context)).rejects.toThrow(
      'job zincirde yok',
    );
  });

  it('kabul edilmiş job başka cüzdana bağlıysa hata verir', async () => {
    const address = await job('accepted');
    await sim.patchJob(address, { agentWallet: Keypair.generate().publicKey });
    await expect(executor().onTask(fakeContext(address, specParts).context)).rejects.toThrow('başka bir agent');
  });

  it('görev kabulden önce kesildiyse tx gönderilmez; işleyiciden sonra kesildiyse teslim edilmez', async () => {
    const early = fakeContext(await job('funded'), specParts);
    early.abort.abort();
    await executor().onTask(early.context);
    expect(sim.sent).toEqual([]);

    const late = fakeContext(await job('funded'), specParts);
    const abortingExecutor = createJobExecutor({
      client: sim.client,
      sender: createTxSender({ connection: sim.connection(), commitment: 'confirmed', client: sim.client }),
      wallet: toWallet(signer),
      capabilities: [STATS],
      handler: async () => {
        late.abort.abort();
        return 'geç';
      },
      delivery: {
        upload: async () => {
          throw new Error('çağrılmamalı');
        },
      },
      autoListClaim: { discountBps: 500 },
      tx: {},
      now: () => Math.floor(Date.now() / 1000),
      onError: (error) => errors.push(error),
    });
    await abortingExecutor.onTask(late.context);
    expect(sim.sent.map((ix) => ix.name)).toEqual(['acceptJob']);
    expect(late.calls.some((call) => call.startsWith('complete'))).toBe(false);
  });

  it('işleyici geçersiz çıktı dönerse hata verir', async () => {
    const bad = createJobExecutor({
      client: sim.client,
      sender: createTxSender({ connection: sim.connection(), commitment: 'confirmed', client: sim.client }),
      wallet: toWallet(signer),
      capabilities: [STATS],
      handler: async () => ({ content: 42 as never, contentType: 'text/plain' }),
      delivery: { upload: async () => ({ workHash: '', deliveryUri: '', contentType: '', size: 0 }) },
      tx: {},
      now: () => 0,
      onError: () => undefined,
    });
    await expect(bad.onTask(fakeContext(await job('accepted'), specParts).context)).rejects.toThrow('content');
  });
});

describe('claimPrice ve discountBps', () => {
  it('nominal değerin bps altı, aşağı yuvarlanır', () => {
    expect(claimPrice(10_000n, 250)).toBe(9_750n);
    expect(claimPrice(3n, 5_000)).toBe(1n);
    expect(claimPrice(1n, 1)).toBe(0n);
  });

  it('1 ile 9999 arası tamsayı', () => {
    expect(() => assertDiscountBps(1)).not.toThrow();
    expect(() => assertDiscountBps(9_999)).not.toThrow();
    for (const bad of [0, 10_000, 1.5, -1, Number.NaN]) expect(() => assertDiscountBps(bad)).toThrow();
  });
});
