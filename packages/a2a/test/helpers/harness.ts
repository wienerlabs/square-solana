// Test fixture: gerçek HTTP sunucusunda A2A sunucusu, izole Postgres'te görev deposu ve test zincirinde
// job'lar. Agent davranışı job adresine göre test içinden verilir.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { specHashing } from '@squaresdk/solana-sdk';
import type { IsolatedDatabase } from '@squaresdk/solana-db/testing';
import type { Message } from '@squaresdk/solana-types';
import { createApiKeyAuthenticator } from '../../src/auth.js';
import { createA2aClient, type A2aClient } from '../../src/client.js';
import { createPrismaTaskStore } from '../../src/prisma-store.js';
import { createA2aServer, type A2aServer, type A2aServerLimits, type TaskContext } from '../../src/server.js';
import { createChainJobSource } from '../../src/square.js';
import { AGENT_RECORD } from './fixtures.js';
import { JobChain } from './jobs.js';

export const KEY_A = 'kurum-a-anahtari';
export const KEY_B = 'kurum-b-anahtari';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export const LIMITS: A2aServerLimits = {
  maxBodyBytes: 64 * 1024,
  maxStreams: 8,
  maxStreamsPerCaller: 2,
  heartbeatMs: 1_000,
  streamMaxDurationMs: 30_000,
  blockingTimeoutMs: 5_000,
  maxHistory: 50,
};

export type Script = (context: TaskContext) => Promise<void>;

export const spec = (title: string) => ({ title, deliverable: 'rapor' });
export const specHashOf = (value: unknown) => Buffer.from(specHashing.specHash(value)).toString('hex');

export function openingMessage(job: string, title: string, messageId = `m-${title}`): Message {
  const value = spec(title);
  return {
    messageId,
    role: 'ROLE_USER',
    parts: [{ data: value, mediaType: 'application/json' }],
    metadata: { square: { job, specHash: specHashOf(value) } },
  };
}

export class Harness {
  readonly chain = new JobChain();
  readonly scripts = new Map<string, Script>();
  readonly continuations = new Map<string, (context: TaskContext, message: Message) => Promise<void>>();
  readonly errors: unknown[] = [];
  server!: A2aServer;
  http!: Server;
  url!: string;

  constructor(
    readonly db: IsolatedDatabase,
    readonly limits: A2aServerLimits = LIMITS,
  ) {}

  async start(): Promise<void> {
    this.server = createA2aServer({
      agentRecord: AGENT_RECORD,
      store: createPrismaTaskStore(this.db.client),
      jobSource: createChainJobSource(this.chain.client),
      authenticate: createApiKeyAuthenticator({ keySha256: [sha(KEY_A), sha(KEY_B)] }),
      executor: {
        onTask: async (context) => this.scripts.get(context.job.address)?.(context),
        onMessage: async (context, message) => this.continuations.get(context.job.address)?.(context, message),
      },
      limits: this.limits,
      onError: (error) => this.errors.push(error),
    });
    this.http = createServer((request, response) => void this.server.handle(request, response));
    await new Promise<void>((resolve) => this.http.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}/a2a`;
  }

  client(key = KEY_A): A2aClient {
    return createA2aClient({
      url: this.url,
      timeoutMs: 10_000,
      allowInsecureHttp: true,
      headers: { 'x-api-key': key },
    });
  }

  async openJob(job: string, title: string, agentRecord = AGENT_RECORD): Promise<void> {
    await this.chain.setJob(job, { status: 'funded', agentRecord, specHash: specHashOf(spec(title)) });
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}

/** Koşul sağlanana kadar bekler (test zaman aşımıyla sınırlı). */
export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('koşul zamanında sağlanmadı');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
