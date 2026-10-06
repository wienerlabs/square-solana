// Test fixture: benzetim zincirinde (sim.ts) job'lar, izole Postgres'te A2A görev deposu, sahte Square API'si
// (teslimat yükleme ve kart barındırma, `createApiClient`'a verilen fetch) ve gerçek HTTP sunucusunda agent.
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { createA2aClient, createApiKeyAuthenticator, type A2aClient } from '@squaresdk/solana-a2a';
import { createPrismaTaskStore } from '@squaresdk/solana-a2a/prisma';
import type { IsolatedDatabase } from '@squaresdk/solana-db/testing';
import { specHashing } from '@squaresdk/solana-sdk';
import { AgentCardSchema, type DeliveryReceipt, type Message, type Task } from '@squaresdk/solana-types';
import { createAgent } from '../../src/agent.js';
import type { Agent, AgentCapability, AgentOptions, JobHandler, JobRequest } from '../../src/types.js';
import { PROGRAM_IDS, SimChain } from './sim.js';

export const CALLER_KEY = 'kurum-anahtari';
export const PUBLIC_URL = 'https://agent.square.test';
export const API_URL = 'https://api.square.test';
export const API_KEY = 'sqk_test_agent';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export const STATS: AgentCapability = {
  id: 'text.stats',
  name: 'Metin istatistiği',
  description: 'Metnin kelime ve cümle sayıları',
  tags: ['text', 'analysis'],
  price: 2_000_000n,
};
export const ECHO: AgentCapability = {
  id: 'text.upper',
  name: 'Büyük harf',
  description: 'Metni büyük harfe çevirir',
  tags: ['text'],
  price: 1_000_000n,
};

/** Spec'teki metnin kelime sayısı ve büyük harfli hali: çıktı girdiye bağlıdır. */
export const handler: JobHandler = async (request) => {
  const text = String((request.spec as { input: string }).input);
  if (request.capability.id === ECHO.id) return text.toUpperCase();
  return {
    content: JSON.stringify({ words: text.split(/\s+/).filter(Boolean).length, job: request.job.address.toBase58() }),
    contentType: 'application/json',
  };
};

export interface Upload {
  job: string;
  content: Uint8Array;
  contentType: string;
  receipt: DeliveryReceipt;
}

/** Square API'sinin teslimat ve kart uçlarını taklit eden fetch. */
export class FakeApi {
  readonly uploads: Upload[] = [];
  readonly cards: { agentRecord: string; agentId: string | null; body: unknown; apiKey: string | null }[] = [];
  /** Verilirse makbuzu değiştirir (bozuk depo testi). */
  tamper: ((receipt: DeliveryReceipt) => DeliveryReceipt) | null = null;
  /** Verilirse kart hash'i bu değerle döner. */
  cardHashOverride: string | null = null;
  uploadStatus = 201;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const apiKey = new Headers(init?.headers).get('x-api-key');
    const envelope = (status: number, data: unknown, error: unknown = null) =>
      new Response(JSON.stringify({ success: status < 400, data, error, meta: { requestId: 'test' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const delivery = /^\/v1\/jobs\/([^/]+)\/deliveries$/.exec(url.pathname);
    if (delivery && method === 'POST') {
      if (this.uploadStatus >= 400) {
        return envelope(this.uploadStatus, null, {
          code: 'forbidden',
          message: 'yetki yok',
          programError: null,
          details: null,
        });
      }
      const file = (init!.body as FormData).get('file') as Blob;
      const content = new Uint8Array(await file.arrayBuffer());
      const workHash = sha(content);
      let receipt: DeliveryReceipt = {
        workHash,
        deliveryUri: `https://cdn.square.test/d/${workHash.slice(0, 32)}`,
        contentType: file.type,
        size: content.length,
      };
      if (this.tamper) receipt = this.tamper(receipt);
      this.uploads.push({ job: decodeURIComponent(delivery[1]!), content, contentType: file.type, receipt });
      return envelope(201, receipt);
    }
    const card = /^\/v1\/agents\/([^/]+)\/card$/.exec(url.pathname);
    if (card && method === 'PUT') {
      const body = JSON.parse(String(init!.body));
      const parsed = AgentCardSchema.parse(body);
      const agentRecord = decodeURIComponent(card[1]!);
      this.cards.push({ agentRecord, agentId: url.searchParams.get('agentId'), body, apiKey });
      const hash = this.cardHashOverride ?? sha(specHashing.canonicalizeSpec(parsed));
      return envelope(200, {
        agentCardUri: `${API_URL}/a/${agentRecord}/.well-known/agent-card.json`,
        agentCardHash: hash,
      });
    }
    return envelope(404, null, { code: 'not_found', message: url.pathname, programError: null, details: null });
  };
}

export interface StartOptions extends Partial<Omit<AgentOptions, 'store' | 'connection' | 'programIds'>> {
  /** Kurum anahtarının yetkili olduğu kurum. */
  institution?: PublicKey;
}

export class AgentHarness {
  readonly sim = new SimChain();
  readonly api = new FakeApi();
  readonly signer = Keypair.generate();
  readonly institution = Keypair.generate().publicKey;
  readonly errors: unknown[] = [];
  readonly requests: JobRequest[] = [];
  agent!: Agent;
  server!: Server;
  url!: string;

  constructor(readonly db: IsolatedDatabase) {}

  async start(options: StartOptions = {}): Promise<void> {
    await this.sim.setConfig();
    const base: AgentOptions = {
      name: 'Metin Ajanı',
      description: 'Metin işleri yapan test agent’ı',
      version: '1.0.0',
      publicUrl: PUBLIC_URL,
      agentId: 'metin-ajani',
      capabilities: [STATS, ECHO],
      handler: async (request) => {
        this.requests.push(request);
        return handler(request);
      },
      signer: this.signer,
      connection: this.sim.connection(),
      programIds: PROGRAM_IDS,
      api: { baseUrl: API_URL, apiKey: API_KEY, fetch: this.api.fetch },
      store: createPrismaTaskStore(this.db.client),
      authenticate: createApiKeyAuthenticator({
        keys: [{ keySha256: sha(CALLER_KEY), institutions: [(options.institution ?? this.institution).toBase58()] }],
      }),
      limits: { blockingTimeoutMs: 10_000, heartbeatMs: 1_000 },
      onError: (error) => this.errors.push(error),
    };
    this.agent = await createAgent({ ...base, ...options });
    this.server = await this.agent.listen({ port: 0, host: '127.0.0.1' });
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  client(key = CALLER_KEY): A2aClient {
    return createA2aClient({
      url: `${this.url}/a2a`,
      timeoutMs: 15_000,
      allowInsecureHttp: true,
      headers: { 'x-api-key': key },
    });
  }

  /** Zincire job koyar; adresi döner. */
  async openJob(
    spec: unknown,
    fields: Partial<{
      amount: bigint;
      status: 'open' | 'funded' | 'accepted' | 'delivered';
      agentWallet: PublicKey;
      deadline: number;
    }> = {},
  ): Promise<PublicKey> {
    const job = Keypair.generate().publicKey;
    await this.sim.setJob(job, {
      institution: this.institution,
      agentRecord: this.agent.agentRecord,
      agentWallet: fields.agentWallet ?? this.signer.publicKey,
      amount: fields.amount ?? 5_000_000n,
      specHash: Buffer.from(specHashing.specHash(spec)).toString('hex'),
      status: fields.status ?? 'funded',
      deadline: fields.deadline ?? Math.floor(Date.now() / 1000) + 3_600,
    });
    return job;
  }

  /** İşi açan mesaj: spec `data` parçası, Square bağı `metadata.square`. */
  message(job: PublicKey, spec: unknown, messageId = `m-${job.toBase58()}`): Message {
    return {
      messageId,
      role: 'ROLE_USER',
      parts: [{ data: spec as never, mediaType: 'application/json' }],
      metadata: { square: { job: job.toBase58(), specHash: Buffer.from(specHashing.specHash(spec)).toString('hex') } },
    };
  }

  /** İşi gönderir ve görev terminal olana kadar bekler. */
  async run(job: PublicKey, spec: unknown): Promise<Task> {
    const sent = await this.client().sendMessage({ message: this.message(job, spec) });
    const task = 'task' in sent ? sent.task : null;
    if (!task) throw new Error('görev dönmedi');
    return this.settle(task.id);
  }

  async settle(taskId: string): Promise<Task> {
    const terminal = new Set([
      'TASK_STATE_COMPLETED',
      'TASK_STATE_FAILED',
      'TASK_STATE_REJECTED',
      'TASK_STATE_CANCELED',
    ]);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const task = await this.client().getTask({ id: taskId, historyLength: 20 });
      if (terminal.has(task.status.state)) return task;
      if (Date.now() > deadline) throw new Error(`görev bitmedi: ${task.status.state}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(): Promise<void> {
    await this.agent?.close();
  }
}

/** Koşul sağlanana kadar bekler. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('koşul zamanında sağlanmadı');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
