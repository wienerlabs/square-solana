// Arbitrator bildirimleri (BE-22): outbox + yeniden deneme. Bir tur üç adımdır:
// 1. **Event'ler:** indexer'ın `chain_events`'inden imleçten (`notification_cursors`) sonraki `DisputeRaised`,
//    `MissingProofEscalated`, `DisputeVote` ve `DisputeDecided` event'leri, o anda aktif arbitrator'ların
//    abone olduğu her uç için kuyruğa girer (`event:<chain_events.id>`). Oy bildirimi oyu veren arbitrator'a
//    gitmez. İmleç yoksa en son event'ten başlar: geçmiş event'ler bildirilmez. Indexer tek yazıcıdır, event
//    kimlikleri yazılış sırasıyla görünür.
// 2. **Son tarih:** açık dispute'un son tarihine `deadlineWarningSeconds` kala, güncel sayımda oy vermemiş
//    arbitrator'ların uçlarına bir kez `dispute.deadline` (`deadline:<job>:<raised_at>`).
// 3. **Teslim:** zamanı gelen satırlar kiralanır (birden çok API örneği aynı satırı almaz), gövde Standard
//    Webhooks imzasıyla (`@squaresdk/solana-hardening`) SSRF korumalı istemciyle gönderilir. Teslimat kimliği
//    satırın kimliğidir; denemelerde değişmez, alıcı tekrarı ayıklar. 2xx teslimatı tamamlar; diğer yanıt ve
//    hatalar üstel geri çekilmeyle yeniden denenir, `maxAttempts`'ta `failed` olur. Arbitrator setten çıkmışsa
//    teslimat yapılmaz (`failed`).
// Kuyruğa alma `(uç, olay)` tekilliğiyle idempotenttir; aynı turu iki örnek çalıştırsa da bildirim bir kez girer.
import type { ArbitrationEvent, Prisma, PrismaClient } from '@squaresdk/solana-db';
import { signWebhook, type SecretBox } from '@squaresdk/solana-hardening';
import { Counter, type Logger, type Registry } from '@squaresdk/solana-observability';
import {
  ArbitrationNotificationSchema,
  IndexedEventSchema,
  type ArbitrationEventType,
  type ArbitrationNotification,
} from '@squaresdk/solana-types';
import { hasVoted } from './arbitration.js';
import type { Arbitrators } from './arbitrators.js';
import { EVENT_TO_DB } from './webhooks.js';

/** İmlecin adı (`notification_cursors.name`). */
export const CURSOR = 'arbitration';

const EVENT_TYPES: Readonly<Record<string, ArbitrationEventType>> = {
  DisputeRaised: 'dispute.raised',
  MissingProofEscalated: 'dispute.escalated',
  DisputeVote: 'dispute.vote',
  DisputeDecided: 'dispute.decided',
};

/** Gönderici: SSRF korumalı istek (`createSafeFetch`); testte yerel sunucuya izinli. */
export type WebhookSender = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface NotifierMetrics {
  /** Bildirimler: `enqueued`, `delivered`, `retried`, `failed`. */
  readonly notifications: Counter<'result'>;
}

export function createNotifierMetrics(registry: Registry): NotifierMetrics {
  return {
    notifications: new Counter({
      name: 'api_arbitration_notifications_total',
      help: 'Arbitrator webhook bildirimleri, sonuca göre',
      labelNames: ['result'],
      registers: [registry],
    }),
  };
}

export interface NotifierRound {
  readonly enqueued: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
}

export interface Notifier {
  runOnce(): Promise<NotifierRound>;
}

/** `attempt`. başarısız denemeden sonraki bekleme: `base × 2^(attempt−1)`, en çok `max` saniye. */
export function retryDelaySeconds(attempt: number, backoff: { baseSeconds: number; maxSeconds: number }): number {
  return Math.min(backoff.maxSeconds, backoff.baseSeconds * 2 ** Math.min(Math.max(attempt - 1, 0), 30));
}

export function createNotifier(deps: {
  db: PrismaClient;
  box: SecretBox;
  arbitrators: Arbitrators;
  send: WebhookSender;
  batchSize: number;
  maxAttempts: number;
  backoff: { baseSeconds: number; maxSeconds: number };
  deadlineWarningSeconds: number;
  /** Teslimat kiralaması; gönderimin süre sınırından uzun olmalı. */
  leaseSeconds: number;
  metrics: NotifierMetrics;
  log: Logger;
  clock?: () => number;
}): Notifier {
  const { db, log, metrics } = deps;
  const clock = deps.clock ?? Date.now;

  async function subscribers(type: ArbitrationEventType) {
    const set = await deps.arbitrators.get();
    const rows = await db.arbitrationWebhook.findMany({
      where: { wallet: { in: [...set.arbitrators] }, events: { has: EVENT_TO_DB[type] } },
      select: { id: true, wallet: true },
    });
    return { set, rows };
  }

  async function enqueue(
    rows: readonly { id: string }[],
    eventKey: string,
    type: ArbitrationEventType,
    notification: ArbitrationNotification,
    now: Date,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const { count } = await db.notificationDelivery.createMany({
      data: rows.map((row) => ({
        webhookId: row.id,
        eventKey,
        type: EVENT_TO_DB[type] as ArbitrationEvent,
        job: notification.job,
        payload: notification as unknown as Prisma.InputJsonValue,
        nextAttemptAt: now,
      })),
      skipDuplicates: true,
    });
    metrics.notifications.inc({ result: 'enqueued' }, count);
    return count;
  }

  async function enqueueEvents(now: Date): Promise<number> {
    const cursor = await db.notificationCursor.findUnique({ where: { name: CURSOR } });
    if (!cursor) {
      const last = await db.chainEvent.aggregate({ _max: { id: true } });
      await db.notificationCursor.create({ data: { name: CURSOR, lastEventId: last._max.id ?? 0n } });
      return 0;
    }
    const events = await db.chainEvent.findMany({
      where: { id: { gt: cursor.lastEventId }, program: 'escrow', name: { in: Object.keys(EVENT_TYPES) } },
      orderBy: { id: 'asc' },
      take: deps.batchSize,
    });
    let enqueued = 0;
    for (const event of events) {
      const type = EVENT_TYPES[event.name]!;
      const job = event.job;
      if (job) {
        const dispute = await db.dispute.findUnique({ where: { job }, select: { deadline: true } });
        const data = (event.payload as { data?: { deadline?: number; arbitrator?: string } }).data ?? {};
        const notification = ArbitrationNotificationSchema.parse({
          type,
          timestamp: Math.floor(now.getTime() / 1000),
          job,
          deadline: dispute ? Number(dispute.deadline) : (data.deadline ?? null),
          event: IndexedEventSchema.parse({
            signature: event.signature,
            slot: Number(event.slot),
            blockTime: event.blockTime === null ? null : Number(event.blockTime),
            instructionIndex: event.instructionIndex,
            eventIndex: event.eventIndex,
            payload: event.payload,
          }),
        });
        const { rows } = await subscribers(type);
        // Oy bildirimi oyu verene gitmez.
        const targets = type === 'dispute.vote' ? rows.filter((row) => row.wallet !== data.arbitrator) : rows;
        enqueued += await enqueue(targets, `event:${event.id}`, type, notification, now);
      }
      await db.notificationCursor.updateMany({
        where: { name: CURSOR, lastEventId: { lt: event.id } },
        data: { lastEventId: event.id },
      });
    }
    return enqueued;
  }

  async function enqueueDeadlines(now: Date): Promise<number> {
    const seconds = BigInt(Math.floor(now.getTime() / 1000));
    const window = { gt: seconds, lte: seconds + BigInt(deps.deadlineWarningSeconds) };
    const dueAfter = (after: { deadline: bigint; job: string } | null) =>
      db.dispute.findMany({
        where: {
          jobStatus: 'disputed',
          deadline: window,
          ...(after && {
            OR: [{ deadline: { gt: after.deadline } }, { deadline: after.deadline, job: { gt: after.job } }],
          }),
        },
        orderBy: [{ deadline: 'asc' }, { job: 'asc' }],
        take: deps.batchSize,
      });
    const keyOf = (dispute: { job: string; raisedAt: bigint }) => `deadline:${dispute.job}:${dispute.raisedAt}`;
    let due = await dueAfter(null);
    if (due.length === 0) return 0;
    const { set, rows } = await subscribers('dispute.deadline');
    let enqueued = 0;
    let warned = 0;
    while (due.length > 0 && rows.length > 0) {
      const queued = await db.notificationDelivery.findMany({
        where: { eventKey: { in: due.map(keyOf) }, webhookId: { in: rows.map((row) => row.id) } },
        select: { eventKey: true, webhookId: true },
      });
      const already = new Set(queued.map((row) => `${row.webhookId} ${row.eventKey}`));
      for (const dispute of due) {
        const eventKey = keyOf(dispute);
        // Güncel sayımda oy vermiş arbitrator'a hatırlatma gitmez.
        const targets = rows.filter((row) => {
          if (already.has(`${row.id} ${eventKey}`)) return false;
          const index = set.arbitrators.indexOf(row.wallet);
          return !hasVoted(
            { approvalMask: dispute.approvalMask, arbitratorSetVersion: Number(dispute.arbitratorSetVersion) },
            index,
            set.version,
          );
        });
        if (targets.length === 0) continue;
        const notification = ArbitrationNotificationSchema.parse({
          type: 'dispute.deadline',
          timestamp: Math.floor(now.getTime() / 1000),
          job: dispute.job,
          deadline: Number(dispute.deadline),
          event: null,
        });
        enqueued += await enqueue(targets, eventKey, 'dispute.deadline', notification, now);
        warned += 1;
        if (warned === deps.batchSize) return enqueued;
      }
      if (due.length < deps.batchSize) break;
      due = await dueAfter(due[due.length - 1]!);
    }
    return enqueued;
  }

  async function deliver(now: Date): Promise<Omit<NotifierRound, 'enqueued'>> {
    const result = { delivered: 0, retried: 0, failed: 0 };
    const free = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
    const candidates = await db.notificationDelivery.findMany({
      where: { state: 'pending', nextAttemptAt: { lte: now }, ...free },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: deps.batchSize,
      include: { webhook: true },
    });
    const set = candidates.length > 0 ? await deps.arbitrators.get() : null;
    for (const row of candidates) {
      // Kiralama: başka bir örnek aynı satırı aldıysa atlanır.
      const leasedAt = clock();
      const { count } = await db.notificationDelivery.updateMany({
        where: {
          id: row.id,
          state: 'pending',
          attempts: row.attempts,
          nextAttemptAt: { lte: new Date(leasedAt) },
          OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date(leasedAt) } }],
        },
        data: { lockedUntil: new Date(leasedAt + deps.leaseSeconds * 1000) },
      });
      if (count === 0) continue;
      const attempts = row.attempts + 1;
      if (!set!.arbitrators.includes(row.webhook.wallet)) {
        await db.notificationDelivery.update({
          where: { id: row.id },
          data: { state: 'failed', attempts, lockedUntil: null, lastError: 'arbitrator aktif setten çıktı' },
        });
        result.failed += 1;
        metrics.notifications.inc({ result: 'failed' });
        continue;
      }
      const body = JSON.stringify(row.payload);
      let status: number | null = null;
      let error: string | null = null;
      try {
        const secret = deps.box.openText(row.webhook.secret, row.webhook.id);
        const headers = signWebhook({ secret, id: row.id, timestamp: Math.floor(clock() / 1000), payload: body });
        ({ status } = await deps.send(row.webhook.url, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body,
        }));
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (status !== null && status >= 200 && status < 300) {
        await db.notificationDelivery.update({
          where: { id: row.id },
          data: {
            state: 'delivered',
            attempts,
            lastStatus: status,
            lastError: null,
            lockedUntil: null,
            deliveredAt: now,
          },
        });
        result.delivered += 1;
        metrics.notifications.inc({ result: 'delivered' });
        continue;
      }
      const exhausted = attempts >= deps.maxAttempts;
      const lastError = error ?? `HTTP ${status}`;
      await db.notificationDelivery.update({
        where: { id: row.id },
        data: {
          state: exhausted ? 'failed' : 'pending',
          attempts,
          lastStatus: status !== null && status >= 100 && status <= 599 ? status : null,
          lastError: lastError.slice(0, 500),
          lockedUntil: null,
          nextAttemptAt: new Date(now.getTime() + retryDelaySeconds(attempts, deps.backoff) * 1000),
        },
      });
      if (exhausted) {
        result.failed += 1;
        metrics.notifications.inc({ result: 'failed' });
        log.warn('notification_failed', { delivery: row.id, webhook: row.webhookId, attempts, error: lastError });
      } else {
        result.retried += 1;
        metrics.notifications.inc({ result: 'retried' });
      }
    }
    return result;
  }

  return {
    async runOnce() {
      const now = new Date(clock());
      const enqueued = (await enqueueEvents(now)) + (await enqueueDeadlines(now));
      return { enqueued, ...(await deliver(now)) };
    },
  };
}
