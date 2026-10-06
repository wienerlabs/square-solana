// createAgent uçtan uca (benzetim zinciri, gerçek A2A sunucusu ve Postgres görev deposu): kartın well-known
// yolunda sunulması, A2A görev akışı, kabul / teslim tx'leri, autoListClaim ve hata durumları.
import { createHash } from 'node:crypto';
import { AgentCard as OfficialCard, SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Keypair } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import { startIsolatedDatabase, type IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { AgentCardSchema, type Task } from '@squaresdk/solana-types';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AgentTxError } from '../src/chain.js';
import type { ClaimListing } from '../src/types.js';
import { AgentHarness, CALLER_KEY, ECHO, PUBLIC_URL, STATS, until } from './helpers/harness.js';
import { PROGRAM_IDS } from './helpers/sim.js';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hex = (bytes: readonly number[] | Uint8Array) => Buffer.from(bytes).toString('hex');

let db: IsolatedDatabase;
let h: AgentHarness;

beforeAll(async () => {
  db = await startIsolatedDatabase();
});

afterAll(async () => {
  await db?.stop();
});

beforeEach(async () => {
  await db.truncate();
  h = new AgentHarness(db);
});

afterEach(async () => {
  await h.stop();
});

const receiptOf = (task: Task) =>
  task.artifacts?.find((a) => a.artifactId === 'delivery')?.parts.find((p) => p.data !== undefined)?.data as
    { workHash: string; deliveryUri: string; contentType: string; size: number } | undefined;

describe('agent card', () => {
  it('well-known yolunda kanonik baytlar; hash, DID, fiyat ve A2A v1.0 arayüzü', async () => {
    await h.start();
    const response = await fetch(`${h.url}/.well-known/agent-card.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).equals(Buffer.from(h.agent.cardBytes))).toBe(true);
    expect(sha(bytes)).toBe(h.agent.cardHash);
    expect(response.headers.get('etag')).toBe(`"${h.agent.cardHash}"`);

    const card = AgentCardSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
    expect(card.url).toBe(`${PUBLIC_URL}/a2a`);
    expect(card.supportedInterfaces).toEqual([
      { url: `${PUBLIC_URL}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ]);
    expect(card.skills.map((s) => s.id)).toEqual([STATS.id, ECHO.id]);
    expect(card.pricing).toEqual([
      { skillId: STATS.id, amount: '2000000', mint: h.sim.settlementMint.toBase58() },
      { skillId: ECHO.id, amount: '1000000', mint: h.sim.settlementMint.toBase58() },
    ]);
    const [record] = h.sim.client.pda.agentRecord(h.signer.publicKey, 'metin-ajani');
    expect(h.agent.agentRecord.equals(record)).toBe(true);
    const chainRef = h.sim.genesisHash.slice(0, 32);
    expect(card.registrations).toEqual([
      { agentRegistry: `solana:${chainRef}:${PROGRAM_IDS.registry.toBase58()}`, agentId: record.toBase58() },
    ]);
    expect(h.agent.did).toBe(`did:aip:solana:${chainRef}:${PROGRAM_IDS.registry.toBase58()}:${record.toBase58()}`);
    expect(squareIdentity.parseDidAip(h.agent.did).version).toBe(2);
    expect(card.services).toContainEqual({ name: 'DID', endpoint: h.agent.did });
    expect(card.services).toContainEqual({ name: 'Agent Card', endpoint: `${PUBLIC_URL}/.well-known/agent-card.json` });
  });

  it('HEAD, koşullu GET, yanlış yöntem ve bilinmeyen yol', async () => {
    await h.start();
    const head = await fetch(`${h.url}/.well-known/agent-card.json`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const cached = await fetch(`${h.url}/.well-known/agent-card.json`, {
      headers: { 'if-none-match': `"${h.agent.cardHash}"` },
    });
    expect(cached.status).toBe(304);
    const post = await fetch(`${h.url}/.well-known/agent-card.json`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect((await fetch(`${h.url}/.well-known/agent.json`)).status).toBe(404);
  });

  it('public URL yol öneki taşıyorsa yollar önekin altında', async () => {
    await h.start({ publicUrl: `${PUBLIC_URL}/ajanlar/metin/` });
    expect(h.agent.cardUrl).toBe(`${PUBLIC_URL}/ajanlar/metin/.well-known/agent-card.json`);
    expect(h.agent.a2aUrl).toBe(`${PUBLIC_URL}/ajanlar/metin/a2a`);
    expect((await fetch(`${h.url}/ajanlar/metin/.well-known/agent-card.json`)).status).toBe(200);
    expect((await fetch(`${h.url}/.well-known/agent-card.json`)).status).toBe(404);
  });

  it("A2A'nın resmi istemcisi kartı well-known yolundan okuyup işi gönderir", async () => {
    await h.start();
    const job = await h.openJob({ capability: ECHO.id, input: 'resmi istemci' });
    // Kart https public adresini ilan eder; testte istekler yerel sunucuya yönlendirilir.
    const local: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('x-api-key', CALLER_KEY);
      return fetch(String(input instanceof Request ? input.url : input).replace(PUBLIC_URL, h.url), {
        ...init,
        headers,
      });
    };
    const cardJson = await (await local(`${PUBLIC_URL}/.well-known/agent-card.json`)).json();
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: local })],
      }),
    );
    const client = await factory.createFromAgentCard(OfficialCard.fromJSON(cardJson));
    const sent = await client.sendMessage(
      SendMessageRequest.fromJSON({ message: h.message(job, { capability: ECHO.id, input: 'resmi istemci' }) }),
    );
    const id = (sent as { id: string }).id;
    const task = await h.settle(id);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('job akışı', () => {
  it('kabul → işleyici → teslimat yükleme → submit_work; görev COMPLETED ve artefakt makbuzu taşır', async () => {
    await h.start();
    const spec = { capability: STATS.id, input: 'bir iki üç dört beş' };
    const job = await h.openJob(spec);
    const task = await h.run(job, spec);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.contextId).toBe(job.toBase58());

    // İşleyici zincirdeki job'u ve doğrulanmış spec'i aldı.
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.capability.id).toBe(STATS.id);
    expect(h.requests[0]!.spec).toEqual(spec);
    expect(h.requests[0]!.job.amount).toBe(5_000_000n);

    // Teslimat API'ye yüklendi; içerik işleyicinin girdiye bağlı çıktısı.
    expect(h.api.uploads).toHaveLength(1);
    const upload = h.api.uploads[0]!;
    expect(upload.job).toBe(job.toBase58());
    expect(upload.contentType).toBe('application/json');
    expect(JSON.parse(Buffer.from(upload.content).toString('utf8'))).toEqual({ words: 5, job: job.toBase58() });

    // Tx'ler: accept_job (spec hash'iyle) sonra submit_work (içeriğin SHA-256'sı ve URI); imzacı agent cüzdanı.
    expect(h.sim.sent.map((ix) => ix.name)).toEqual(['acceptJob', 'submitWork']);
    const [accept, submit] = h.sim.sent;
    expect(hex(accept!.data.specHash as number[])).toBe(sha(Buffer.from(JSON.stringify(spec))));
    expect(accept!.accounts[0]!.equals(h.signer.publicKey)).toBe(true);
    expect(accept!.signers).toEqual([h.signer.publicKey.toBase58()]);
    expect(hex(submit!.data.workHash as number[])).toBe(sha(upload.content));
    expect(submit!.data.deliveryUri).toBe(upload.receipt.deliveryUri);
    expect(h.sim.jobStatus(job)).toBe('delivered');
    expect(h.sim.job(job)!.deliveryUri).toBe(upload.receipt.deliveryUri);

    const receipt = receiptOf(task);
    expect(receipt).toEqual(upload.receipt);
    const parts = task.artifacts![0]!.parts;
    expect(parts.find((p) => p.url)?.url).toBe(upload.receipt.deliveryUri);
    expect(parts.find((p) => p.text)?.text).toBe(Buffer.from(upload.content).toString('utf8'));
    expect(task.history?.some((m) => m.parts.some((p) => p.text?.startsWith('teslim edildi: submit_work')))).toBe(true);
    expect(h.errors).toEqual([]);
  });

  it('tek capability varsa spec capability belirtmeyebilir', async () => {
    await h.start({ capabilities: [ECHO] });
    const spec = { input: 'küçük harf' };
    const task = await h.run(await h.openJob(spec), spec);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(Buffer.from(h.api.uploads[0]!.content).toString('utf8')).toBe('KÜÇÜK HARF');
    expect(h.api.uploads[0]!.contentType).toBe('text/plain; charset=utf-8');
  });

  it('autoListClaim: teslimden sonra alacağı indirimli fiyatla listeler', async () => {
    const listed: ClaimListing[] = [];
    await h.start({ autoListClaim: { discountBps: 250 }, onClaimListed: (listing) => listed.push(listing) });
    const spec = { capability: STATS.id, input: 'alacak satışı' };
    const job = await h.openJob(spec, { amount: 8_000_000n });
    const task = await h.run(job, spec);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    await until(() => listed.length === 1);
    expect(h.sim.sent.map((ix) => ix.name)).toEqual(['acceptJob', 'submitWork', 'listClaim']);
    const listing = h.sim.claimListing(job)!;
    expect(listing.price.toString()).toBe('7800000');
    expect(listing.faceValue.toString()).toBe('8000000');
    expect(listing.seller.equals(h.signer.publicKey)).toBe(true);
    expect(listed[0]!.price).toBe(7_800_000n);
    expect(listed[0]!.job.equals(job)).toBe(true);
  });

  it('list_claim düşerse görev COMPLETED kalır, hata bildirilir', async () => {
    await h.start({ autoListClaim: { discountBps: 100 } });
    h.sim.failure = (name) => (name === 'listClaim' ? new Error('rpc kapalı') : null);
    const spec = { capability: STATS.id, input: 'listeleme hatası' };
    const task = await h.run(await h.openJob(spec), spec);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    await until(() => h.errors.length > 0);
    expect(String((h.errors[0] as Error).message)).toContain('list_claim');
  });
});

describe('ret ve hata durumları', () => {
  const rejected = async (task: Task, text: string) => {
    expect(task.status.state).toBe('TASK_STATE_REJECTED');
    expect(task.status.message?.parts[0]?.text).toContain(text);
    expect(h.sim.sent).toEqual([]);
    expect(h.api.uploads).toEqual([]);
  };

  it('job tutarı capability fiyatının altında', async () => {
    await h.start();
    const spec = { capability: STATS.id, input: 'ucuz' };
    await rejected(await h.run(await h.openJob(spec, { amount: 1_999_999n }), spec), 'fiyatının');
  });

  it('bilinmeyen ya da belirtilmeyen capability', async () => {
    await h.start();
    const unknown = { capability: 'image.render', input: 'x' };
    await rejected(await h.run(await h.openJob(unknown), unknown), 'bilinmeyen capability');
    const unnamed = { input: 'x' };
    await rejected(await h.run(await h.openJob(unnamed), unnamed), 'capability belirtmeli');
    const wrongType = { capability: 7, input: 'x' };
    await rejected(await h.run(await h.openJob(wrongType), wrongType), 'metin olmalı');
  });

  it('fonlanmamış job, başka cüzdana bağlı job ve geçmiş deadline', async () => {
    await h.start();
    const spec = { capability: STATS.id, input: 'a' };
    await rejected(await h.run(await h.openJob(spec, { status: 'open' }), spec), 'fonlanmamış');
    const other = { capability: STATS.id, input: 'b' };
    await rejected(
      await h.run(await h.openJob(other, { agentWallet: Keypair.generate().publicKey }), other),
      'agent cüzdanı',
    );
    const late = { capability: STATS.id, input: 'c' };
    await rejected(await h.run(await h.openJob(late, { deadline: 1_000 }), late), 'deadline');
  });

  it('spec parçası olmayan mesaj', async () => {
    await h.start();
    const spec = { capability: STATS.id, input: 'gizli spec' };
    const job = await h.openJob(spec);
    const message = h.message(job, spec);
    message.parts = [{ text: 'spec yok' }];
    const sent = await h.client().sendMessage({ message });
    await rejected(await h.settle((sent as { task: Task }).task.id), 'data parçası');
  });

  it('işleyici hata verirse görev FAILED, job kabul edilmiş kalır', async () => {
    await h.start({
      handler: async () => {
        throw new Error('model kapalı');
      },
    });
    const spec = { capability: STATS.id, input: 'hata' };
    const job = await h.openJob(spec);
    const task = await h.run(job, spec);
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(h.sim.sent.map((ix) => ix.name)).toEqual(['acceptJob']);
    expect(h.sim.jobStatus(job)).toBe('accepted');
    expect(h.errors.some((e) => (e as Error).message === 'model kapalı')).toBe(true);
  });

  it('teslimat deposu yanlış workHash dönerse submit_work gönderilmez', async () => {
    await h.start();
    h.api.tamper = (receipt) => ({ ...receipt, workHash: 'ab'.repeat(32) });
    const spec = { capability: STATS.id, input: 'bozuk depo' };
    const job = await h.openJob(spec);
    const task = await h.run(job, spec);
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect(h.sim.sent.map((ix) => ix.name)).toEqual(['acceptJob']);
    expect(h.errors.some((e) => String((e as Error).message).includes('workHash'))).toBe(true);
  });

  it('teslimat URI’si 128 baytı aşarsa ya da API yüklemeyi reddederse görev FAILED', async () => {
    await h.start();
    h.api.tamper = (receipt) => ({ ...receipt, deliveryUri: `https://cdn.square.test/${'x'.repeat(120)}` });
    const spec = { capability: STATS.id, input: 'uzun uri' };
    expect((await h.run(await h.openJob(spec), spec)).status.state).toBe('TASK_STATE_FAILED');
    h.api.tamper = null;
    h.api.uploadStatus = 403;
    const other = { capability: STATS.id, input: 'yetkisiz' };
    expect((await h.run(await h.openJob(other), other)).status.state).toBe('TASK_STATE_FAILED');
    expect(h.errors.some((e) => String((e as Error).message).includes('teslimat yüklenemedi: forbidden'))).toBe(true);
  });

  it('submit_work program hatası IDL adıyla raporlanır', async () => {
    await h.start();
    const spec = { capability: STATS.id, input: 'program hatası' };
    const job = await h.openJob(spec);
    // Kabulden sonra kaydın cüzdanı değişmiş gibi: submit_work AgentMismatch ile düşer.
    h.sim.before = async (name) => {
      if (name === 'submitWork') await h.sim.patchJob(job, { agentWallet: Keypair.generate().publicKey });
    };
    const task = await h.run(job, spec);
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    const error = h.errors.find((e) => e instanceof AgentTxError) as AgentTxError;
    expect(error.program).toBe('escrow');
    expect(error.message).toMatch(/^submit_work: escrow agentMismatch \(\d+\)$/i);
  });

  it('başka kurumun anahtarı job için görev açamaz (A2A kapısı)', async () => {
    await h.start({ institution: Keypair.generate().publicKey });
    const spec = { capability: STATS.id, input: 'yabancı' };
    const job = await h.openJob(spec);
    await expect(h.client().sendMessage({ message: h.message(job, spec) })).rejects.toThrow();
    expect(h.sim.sent).toEqual([]);
  });

  it('kimliksiz istek 401', async () => {
    await h.start();
    const response = await fetch(`${h.url}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    });
    expect(response.status).toBe(401);
  });
});

describe('yeniden başlatma', () => {
  it('kapanışta yarım kalan görev listen ile sürer; kabul tekrarlanmaz', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    await h.start({
      handler: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return 'sürdürüldü';
      },
    });
    const spec = { capability: STATS.id, input: 'uzun iş' };
    const job = await h.openJob(spec);
    const sent = await h.client().sendMessage({
      message: h.message(job, spec),
      configuration: { returnImmediately: true },
    });
    const taskId = (sent as { task: Task }).task.id;
    await until(() => calls === 1);
    const signer = h.signer;
    const closing = h.agent.close();
    release();
    await closing;
    expect(h.sim.jobStatus(job)).toBe('accepted');

    // Aynı zincir, depo ve cüzdanla yeni süreç.
    const sim = h.sim;
    const api = h.api;
    const next = new AgentHarness(db);
    Object.assign(next, { sim, api, signer, institution: h.institution });
    h = next;
    await h.start();
    const task = await h.settle(taskId);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(sim.sent.map((ix) => ix.name)).toEqual(['acceptJob', 'submitWork']);
    // Yeni süreç varsayılan işleyiciyle işi yeniden yapar.
    expect(JSON.parse(Buffer.from(api.uploads.at(-1)!.content).toString('utf8'))).toEqual({
      words: 2,
      job: job.toBase58(),
    });
  });
});

describe('createAgent doğrulaması', () => {
  it('geçersiz yapılandırmayı reddeder', async () => {
    await expect(h.start({ publicUrl: 'http://agent.square.test' })).rejects.toThrow('https');
    await expect(h.start({ publicUrl: 'yol' })).rejects.toThrow('mutlak');
    await expect(h.start({ publicUrl: `${PUBLIC_URL}/?a=1` })).rejects.toThrow('sorgu');
    await expect(h.start({ agentId: 'boşluklu kimlik' })).rejects.toThrow('agentId');
    await expect(h.start({ capabilities: [] })).rejects.toThrow('en az bir capability');
    await expect(h.start({ capabilities: [STATS, STATS] })).rejects.toThrow('iki kez');
    await expect(h.start({ capabilities: [{ ...STATS, price: 0n }] })).rejects.toThrow('fiyatı');
    await expect(h.start({ autoListClaim: { discountBps: 0 } })).rejects.toThrow('discountBps');
    await expect(h.start({ autoListClaim: { discountBps: 10_000 } })).rejects.toThrow('discountBps');
    await expect(h.start({ chainRef: 'kısa' })).rejects.toThrow('chainRef');
    await expect(h.start({ api: undefined })).rejects.toThrow('api ya da delivery');
    await expect(h.start({ name: '' })).rejects.toThrow('agent card geçersiz');
  });

  it('escrow config zincirde yoksa açılmaz', async () => {
    const { createAgent } = await import('../src/agent.js');
    const { SimChain } = await import('./helpers/sim.js');
    const empty = new SimChain();
    await expect(
      createAgent({
        name: 'x',
        description: 'x',
        version: '1',
        publicUrl: PUBLIC_URL,
        agentId: 'x',
        capabilities: [STATS],
        handler: async () => 'x',
        signer: Keypair.generate(),
        connection: empty.connection(),
        programIds: PROGRAM_IDS,
        delivery: { upload: async () => ({ workHash: '', deliveryUri: '', contentType: '', size: 0 }) },
        store: {} as never,
        authenticate: () => null,
      }),
    ).rejects.toThrow('escrow config');
  });

  it('verilen chainRef DID ve kayıt bağlantısında kullanılır', async () => {
    const chainRef = Keypair.generate().publicKey.toBase58().slice(0, 32);
    await h.start({ chainRef });
    expect(h.agent.did).toContain(`:${chainRef}:`);
  });
});
