// Arbitrator bildirimleri: outbox'a alma (event imleci, son tarih uyarısı), Standard Webhooks imzalı teslim,
// yeniden deneme, deneme sınırı, setten çıkan arbitrator ve iki göndericinin aynı satırı bir kez teslim etmesi.
// Alıcı yerel bir HTTP sunucusudur; imza `@squaresdk/solana-hardening`'in `verifyWebhook`'uyla doğrulanır.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BN } from '@anchor-lang/core';
import { createSafeFetch, generateWebhookSecret, verifyWebhook } from '@squaresdk/solana-hardening';
import { createPrismaReplayStore } from '@squaresdk/solana-hardening/prisma';
import { createLogger, createServiceMetrics } from '@squaresdk/solana-observability';
import { ArbitrationNotificationSchema, type ArbitrationNotification } from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import {
  CURSOR,
  createNotifier,
  createNotifierMetrics,
  retryDelaySeconds,
  type Notifier,
} from '../src/disputes/notifier.js';
import { loadOpenApi } from '../src/openapi.js';
import { PUBLIC_BASE_URL, startStack, truncate, type Stack } from './fixtures/stack.js';
import { World, wallet, type Wallet } from './fixtures/world.js';

const NOW = 1_790_000_000;
const WARNING = 3_600;
const BACKOFF = { baseSeconds: 30, maxSeconds: 600 };

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let stack: Stack;
let world: World;
let receiver: Server;
let receiverUrl: string;
const received: Received[] = [];
/** Alıcının sonraki yanıt durumları (sırayla); boşsa 204. */
const statuses: number[] = [];
let clock = NOW * 1000;
let onDelivery: ((id: string) => Promise<void>) | null = null;
let panel: Wallet[];
let agentRecord: string;

beforeAll(async () => {
  stack = await startStack({ openapi: loadOpenApi(inject('openapiPath'), PUBLIC_BASE_URL) });
  world = new World(stack.db, stack.rpc, stack.client);
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        await onDelivery?.(String(req.headers['webhook-id']));
        received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(statuses.shift() ?? 204).end();
      })();
    });
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
afterAll(async () => {
  receiver.closeAllConnections();
  receiver.close();
  await stack.close();
});
beforeEach(async () => {
  await truncate(stack.db);
  stack.rpc.reset();
  received.length = 0;
  statuses.length = 0;
  clock = NOW * 1000;
  onDelivery = null;
  panel = [wallet(), wallet(), wallet()];
  agentRecord = await world.agent(wallet().address, wallet().address);
  await setPanel(panel);
});

const setPanel = (members: Wallet[], version = 1) =>
  world.escrowConfig(
    members.map((m) => m.address),
    2,
    version,
    stack.client.pda.escrowConfig()[0],
  );

function notifier(maxAttempts = 3, batchSize = 50): Notifier {
  // Test alıcısı yerel adrestedir: SSRF denetimi yalnızca burada özel adrese izin verir.
  const safeFetch = createSafeFetch({
    allowHttp: true,
    allowPrivateAddresses: true,
    timeoutMs: 2_000,
    maxBytes: 1_024,
    maxRedirects: 0,
  });
  return createNotifier({
    db: stack.db,
    box: stack.box,
    arbitrators: stack.arbitrators,
    send: async (url, init) => ({ status: (await safeFetch(url, init)).status }),
    batchSize,
    maxAttempts,
    backoff: BACKOFF,
    deadlineWarningSeconds: WARNING,
    leaseSeconds: 5,
    metrics: createNotifierMetrics(createServiceMetrics({ service: 'api-test', version: '0.0.0' }).registry),
    log: createLogger({ service: 'api-test', level: 'error' }),
    clock: () => clock,
  });
}

/** Arbitrator'ın aboneliği; sır döner. */
async function subscribe(
  member: Wallet,
  path: string,
  events = ['disputeRaised', 'disputeEscalated', 'disputeVote', 'disputeDecided', 'disputeDeadline'],
) {
  const id = randomUUID();
  const secret = generateWebhookSecret();
  await stack.db.arbitrationWebhook.create({
    data: {
      id,
      wallet: member.address,
      url: `${receiverUrl}${path}`,
      events: events as never,
      secret: stack.box.seal(secret, id),
    },
  });
  return secret;
}

const disputedJob = (dispute: Record<string, unknown> = {}) =>
  world.job({
    institution: wallet().address,
    agentRecord,
    agentWallet: wallet().address,
    disputed: true,
    dispute: { deadline: new BN(NOW + 86_400), arbitratorSetVersion: 1, approvalMask: 0, ...dispute },
  });

async function verified(entry: Received, secret: string): Promise<ArbitrationNotification> {
  await verifyWebhook({
    secrets: [secret],
    headers: entry.headers as Record<string, string>,
    payload: entry.body,
    toleranceSeconds: 10 ** 9,
    replay: createPrismaReplayStore(stack.db),
    scope: `test:${randomUUID()}`,
  });
  return ArbitrationNotificationSchema.parse(JSON.parse(entry.body));
}

describe('bildirim', () => {
  it('imleçten sonraki dispute event’leri abonelere imzalı gider; oy bildirimi oyu verene gitmez', async () => {
    const first = await subscribe(panel[0]!, '/a');
    const second = await subscribe(panel[1]!, '/b');
    await subscribe(panel[2]!, '/c', ['disputeDecided']);
    const job = await disputedJob();
    // İmleç kurulmadan önceki event bildirilmez.
    await world.chainEvent(job.address, 'DisputeRaised', { deadline: new BN(NOW + 86_400) });
    const run = notifier();
    expect(await run.runOnce()).toEqual({ enqueued: 0, delivered: 0, retried: 0, failed: 0 });
    expect((await stack.db.notificationCursor.findUniqueOrThrow({ where: { name: CURSOR } })).lastEventId).toBe(1n);

    await world.chainEvent(job.address, 'DisputeRaised', { deadline: new BN(NOW + 86_400) });
    await world.chainEvent(job.address, 'JobFunded', {});
    await world.chainEvent(job.address, 'DisputeVote', {
      arbitrator: new PublicKey(panel[0]!.address),
      resolution: { favorAgent: {} },
      approvalCount: 1,
    });
    expect(await run.runOnce()).toEqual({ enqueued: 3, delivered: 3, retried: 0, failed: 0 });
    const byPath = (path: string) => received.filter((entry) => entry.path === path);
    expect(byPath('/a')).toHaveLength(1);
    expect(byPath('/b')).toHaveLength(2);
    expect(byPath('/c')).toHaveLength(0);
    const raised = await verified(byPath('/a')[0]!, first);
    expect(raised).toMatchObject({
      type: 'dispute.raised',
      job: job.address,
      deadline: NOW + 86_400,
      event: { payload: { name: 'DisputeRaised' } },
    });
    const toB = await Promise.all(byPath('/b').map((entry) => verified(entry, second)));
    expect(toB.map((notification) => notification.type).sort()).toEqual(['dispute.raised', 'dispute.vote']);
    expect(toB.find((notification) => notification.type === 'dispute.vote')).toMatchObject({
      event: { payload: { data: { arbitrator: panel[0]!.address } } },
    });
    // Başka sırla imza geçmez.
    await expect(verified(byPath('/b')[0]!, first)).rejects.toThrow(/imza/);

    // Aynı tur tekrar: yeni event yok, kuyruk boş.
    expect(await run.runOnce()).toEqual({ enqueued: 0, delivered: 0, retried: 0, failed: 0 });
    expect(await stack.db.notificationDelivery.count({ where: { state: 'delivered' } })).toBe(3);
  });

  it('2xx dışı yanıt üstel geri çekilmeyle yeniden denenir; teslimat kimliği değişmez; sınırda failed', async () => {
    await subscribe(panel[0]!, '/a');
    const run = notifier(3);
    await run.runOnce();
    const job = await disputedJob();
    await world.chainEvent(job.address, 'DisputeDecided', { resolution: { favorInstitution: {} } });
    statuses.push(500, 503, 500);
    expect(await run.runOnce()).toMatchObject({ enqueued: 1, retried: 1 });
    const row = await stack.db.notificationDelivery.findFirstOrThrow();
    expect(row).toMatchObject({ state: 'pending', attempts: 1, lastStatus: 500 });
    expect(row.nextAttemptAt.getTime()).toBe(clock + BACKOFF.baseSeconds * 1000);
    // Zamanı gelmeden denenmez.
    expect(await run.runOnce()).toMatchObject({ retried: 0, delivered: 0 });
    clock += BACKOFF.baseSeconds * 1000;
    expect(await run.runOnce()).toMatchObject({ retried: 1 });
    expect((await stack.db.notificationDelivery.findFirstOrThrow()).nextAttemptAt.getTime()).toBe(
      clock + 2 * BACKOFF.baseSeconds * 1000,
    );
    clock += 2 * BACKOFF.baseSeconds * 1000;
    expect(await run.runOnce()).toMatchObject({ failed: 1 });
    expect(await stack.db.notificationDelivery.findFirstOrThrow()).toMatchObject({
      state: 'failed',
      attempts: 3,
      lastError: 'HTTP 500',
    });
    expect(new Set(received.map((entry) => entry.headers['webhook-id']))).toEqual(new Set([row.id]));
    expect(retryDelaySeconds(10, BACKOFF)).toBe(BACKOFF.maxSeconds);
  });

  it('ulaşılamayan uç yeniden denenir; setten çıkan arbitrator’a teslim edilmez', async () => {
    await subscribe(panel[0]!, '/a');
    const id = randomUUID();
    await stack.db.arbitrationWebhook.create({
      data: {
        id,
        wallet: panel[1]!.address,
        url: 'http://127.0.0.1:1/kapali',
        events: ['disputeDecided'],
        secret: stack.box.seal(generateWebhookSecret(), id),
      },
    });
    const run = notifier();
    await run.runOnce();
    const job = await disputedJob();
    await world.chainEvent(job.address, 'DisputeDecided', { resolution: { favorAgent: {} } });
    expect(await run.runOnce()).toMatchObject({ enqueued: 2, delivered: 1, retried: 1 });
    const failing = await stack.db.notificationDelivery.findFirstOrThrow({ where: { webhookId: id } });
    expect(failing.lastStatus).toBeNull();
    expect(failing.lastError).toBeTruthy();

    // panel[1] setten çıkarıldı: bekleyen teslimatı gönderilmez.
    await setPanel([panel[0]!, panel[2]!], 2);
    clock += BACKOFF.baseSeconds * 1000;
    expect(await run.runOnce()).toMatchObject({ failed: 1 });
    expect(await stack.db.notificationDelivery.findFirstOrThrow({ where: { webhookId: id } })).toMatchObject({
      state: 'failed',
      lastError: 'arbitrator aktif setten çıktı',
    });
  });

  it('son tarihe yaklaşan dispute: oy vermemiş arbitrator’lara bir kez dispute.deadline', async () => {
    const secret = await subscribe(panel[1]!, '/b');
    await subscribe(panel[0]!, '/a');
    await subscribe(panel[2]!, '/c', ['disputeVote']);
    // panel[0] güncel sayımda oy verdi; ikinci dispute'un son tarihi pencerenin dışında; üçüncüsü geçti.
    const soon = await disputedJob({ deadline: new BN(NOW + WARNING - 10), approvalMask: 0b001 });
    await disputedJob({ deadline: new BN(NOW + WARNING + 10) });
    await disputedJob({ deadline: new BN(NOW - 1) });
    const run = notifier();
    expect(await run.runOnce()).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(received.map((entry) => entry.path)).toEqual(['/b']);
    expect(await verified(received[0]!, secret)).toEqual({
      type: 'dispute.deadline',
      timestamp: NOW,
      job: soon.address,
      deadline: NOW + WARNING - 10,
      event: null,
    });
    expect(await run.runOnce()).toMatchObject({ enqueued: 0, delivered: 0 });
  });

  it('turun sınırını aşan son tarih uyarıları sonraki turda sıradaki dispute’lara gider', async () => {
    await subscribe(panel[1]!, '/b');
    const first = await disputedJob({ deadline: new BN(NOW + WARNING - 30) });
    const second = await disputedJob({ deadline: new BN(NOW + WARNING - 20) });
    const third = await disputedJob({ deadline: new BN(NOW + WARNING - 10) });
    const jobsOf = (entries: Received[]) =>
      entries.map((entry) => ArbitrationNotificationSchema.parse(JSON.parse(entry.body)).job).sort();
    const run = notifier(3, 2);
    expect(await run.runOnce()).toMatchObject({ enqueued: 2, delivered: 2 });
    expect(jobsOf(received)).toEqual([first.address, second.address].sort());
    received.length = 0;
    expect(await run.runOnce()).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(jobsOf(received)).toEqual([third.address]);
    expect(await run.runOnce()).toMatchObject({ enqueued: 0, delivered: 0 });
  });

  it('kiralama satır alınırken başlar: yavaş gönderimden sonraki satırın kiralaması dolmuş başlamaz', async () => {
    await subscribe(panel[0]!, '/a');
    await subscribe(panel[1]!, '/b');
    await notifier().runOnce();
    const job = await disputedJob();
    await world.chainEvent(job.address, 'DisputeDecided', { resolution: { favorAgent: {} } });
    const remaining: number[] = [];
    onDelivery = async (id) => {
      const row = await stack.db.notificationDelivery.findUniqueOrThrow({ where: { id } });
      remaining.push(row.lockedUntil!.getTime() - clock);
      clock += 10_000;
    };
    expect(await notifier().runOnce()).toMatchObject({ delivered: 2 });
    expect(remaining).toHaveLength(2);
    expect(remaining.every((ms) => ms > 0)).toBe(true);
  });

  it('iki gönderici aynı satırı bir kez teslim eder (kiralama)', async () => {
    await subscribe(panel[0]!, '/a');
    await subscribe(panel[1]!, '/b');
    const setup = notifier();
    await setup.runOnce();
    for (let i = 0; i < 5; i += 1) {
      const job = await disputedJob();
      await world.chainEvent(job.address, 'DisputeDecided', { resolution: { favorAgent: {} } });
    }
    const [one, two] = await Promise.all([notifier().runOnce(), notifier().runOnce()]);
    expect(one.delivered + two.delivered).toBe(10);
    const ids = received.map((entry) => entry.headers['webhook-id']);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toHaveLength(10);
  });
});
