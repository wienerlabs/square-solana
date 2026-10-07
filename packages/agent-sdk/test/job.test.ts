// Job yürütücüsünün yeniden başlatma ve kesinti yolları (görev bağlamı sahte, zincir benzetim): kabul edilmiş
// job'da kabul tekrarlanmaz, teslim edilmiş job'da yalnızca görev tamamlanır, iptal edilen görevde tx yok.
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { TaskContext } from '@squaresdk/solana-a2a';
import { specHashing } from '@squaresdk/solana-sdk';
import type { JobStatus, Message } from '@squaresdk/solana-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTxSender, toWallet } from '../src/chain.js';
import { assertDiscountBps, claimPrice, createJobExecutor } from '../src/job.js';
import { DeliveryUploadError } from '../src/delivery.js';
import type { Admission, ClaimListing, DeliveryUploader, JobRequest } from '../src/types.js';
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

const FAST_RETRY = { minDelayMs: 1, maxDelayMs: 5, submitMarginSeconds: 30 };

const receiptOf = async (content: Uint8Array, contentType: string) => ({
  workHash: Buffer.from(await crypto.subtle.digest('SHA-256', content)).toString('hex'),
  deliveryUri: 'ipfs://bafy-teslimat',
  contentType,
  size: content.length,
});

function executor(
  options: {
    discountBps?: number;
    upload?: DeliveryUploader['upload'];
    admit?: Admission;
    now?: () => number;
  } = {},
) {
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
    delivery: { upload: options.upload ?? (async ({ content, contentType }) => receiptOf(content, contentType)) },
    ...(options.discountBps ? { autoListClaim: { discountBps: options.discountBps } } : {}),
    ...(options.admit ? { admit: options.admit } : {}),
    retry: FAST_RETRY,
    tx: { computeUnitPrice: 1_000n },
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
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

describe('geçici hatalar ve kabul kapısı', () => {
  const kinds = () => sim.sent.map((ix) => ix.name);

  it('kabulden sonra depo geçici olarak düşerse aynı sonuçla yeniden denenir: iş bir kez yapılır', async () => {
    let attempts = 0;
    const recorded = fakeContext(await job('funded'), specParts);
    await executor({
      upload: async ({ content, contentType }) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('fetch failed');
        if (attempts === 2) throw new DeliveryUploadError('teslimat yüklenemedi: rate_limited', true);
        return receiptOf(content, contentType);
      },
    }).onTask(recorded.context);
    expect(kinds()).toEqual(['acceptJob', 'submitWork']);
    expect(requests).toHaveLength(1);
    expect(attempts).toBe(3);
    expect(recorded.calls.at(-1)).toMatch(/^complete:teslim edildi/);
    expect(errors).toHaveLength(2);
  });

  it('submit_work ve accept_job ağ hatasında yeniden gönderilir', async () => {
    const failed = new Set<string>();
    sim.failure = (name) => {
      if (failed.has(name)) return null;
      failed.add(name);
      return new Error(`${name}: socket hang up`);
    };
    const recorded = fakeContext(await job('funded'), specParts);
    await executor().onTask(recorded.context);
    expect(kinds()).toEqual(['acceptJob', 'submitWork']);
    expect(requests).toHaveLength(1);
    expect(recorded.calls.at(-1)).toMatch(/^complete:teslim edildi/);
  });

  it('kalıcı program hatasında görev düşer ve teslimat artefaktı sunulmaz', async () => {
    const address = await job('funded');
    sim.before = async (name) => {
      if (name === 'submitWork') await sim.patchJob(address, { agentWallet: Keypair.generate().publicKey });
    };
    const recorded = fakeContext(address, specParts);
    await expect(executor().onTask(recorded.context)).rejects.toThrow(/submit_work: escrow agentMismatch/i);
    expect(recorded.calls.some((call) => call.startsWith('addArtifact'))).toBe(false);
    expect(recorded.calls.some((call) => call.startsWith('complete'))).toBe(false);
  });

  it('kabul indikten sonra geride kalan okuma ve InvalidStatus görevi düşürmez', async () => {
    const address = await job('funded');
    const key = address.toBase58();
    const stale = sim.accounts.get(key)!;
    let lagging = 0;
    let confirms = 0;
    sim.confirmFailure = () => (++confirms === 1 ? new Error('confirm zaman aşımı') : null);
    sim.readHook = (seen, info) => {
      if (seen !== key || sim.jobStatus(address) !== 'accepted' || lagging >= 3) return info;
      lagging += 1;
      return lagging === 3 ? new Error('429 Too Many Requests') : stale;
    };
    const recorded = fakeContext(address, specParts);
    await executor().onTask(recorded.context);
    expect(lagging).toBe(3);
    expect(kinds()).toEqual(['acceptJob', 'submitWork']);
    expect(recorded.calls.at(-1)).toMatch(/^complete:teslim edildi/);
    expect(errors.some((error) => /invalidStatus/i.test(String(error)))).toBe(true);
  });

  it('zincirdeki teslim yerel çıktıyla aynı değilse yerel çıktı sunulmaz', async () => {
    const address = await job('accepted');
    let patched = false;
    sim.before = async (name) => {
      if (name !== 'submitWork' || patched) return;
      patched = true;
      await sim.patchJob(address, {
        status: { delivered: {} },
        workHash: new Array(32).fill(9),
        deliveryUri: 'ipfs://onceki-teslimat',
      });
    };
    const recorded = fakeContext(address, specParts);
    await executor().onTask(recorded.context);
    expect(recorded.calls.some((call) => call.startsWith('addArtifact'))).toBe(false);
    expect(recorded.calls.at(-1)).toMatch(/^complete:job zincirde teslim edilmiş/);
  });

  it('depo kalıcı olarak reddederse ya da süre dolarsa yeniden denenmez', async () => {
    const forbidden = fakeContext(await job('funded'), specParts);
    await expect(
      executor({
        upload: async () => {
          throw new DeliveryUploadError('teslimat yüklenemedi: forbidden', false);
        },
      }).onTask(forbidden.context),
    ).rejects.toThrow('forbidden');
    let clock = Math.floor(Date.now() / 1000);
    const late = fakeContext(await job('funded'), specParts);
    await expect(
      executor({
        now: () => clock,
        upload: async () => {
          clock += 3_600;
          throw new TypeError('fetch failed');
        },
      }).onTask(late.context),
    ).rejects.toThrow('job süresi doldu');
  });

  it('admit metin dönerse görev kabulden önce reddedilir, tx gönderilmez', async () => {
    const seen: string[] = [];
    const recorded = fakeContext(await job('funded'), specParts);
    await executor({
      admit: ({ capability, taskId }) => {
        seen.push(`${capability.id}:${taskId}`);
        return 'kapasite dolu';
      },
    }).onTask(recorded.context);
    expect(sim.sent).toEqual([]);
    expect(recorded.calls).toEqual(['reject:kapasite dolu']);
    expect(seen).toEqual([`${STATS.id}:${recorded.context.taskId}`]);
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

describe('createTxSender', () => {
  it('processed yapılandırmasında gönderim en az confirmed ile onaylanır', async () => {
    const seen: unknown[] = [];
    const connection = sim.connection();
    const confirm = connection.confirmTransaction.bind(connection);
    Object.assign(connection, {
      confirmTransaction: async (...args: Parameters<typeof connection.confirmTransaction>) => {
        seen.push(args[1]);
        return confirm(...args);
      },
    });
    const address = await job('funded');
    const sender = createTxSender({ connection, commitment: 'processed', client: sim.client });
    const built = await sim.client.flow.acceptJob(
      { agent: signer.publicKey, job: address },
      { feePayer: signer.publicKey },
    );
    await sender.send('accept_job', built, [toWallet(signer)]);
    expect(seen).toEqual(['confirmed']);
  });
});
