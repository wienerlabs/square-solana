// Helius webhook'u (raw tx biçimi): Helius, eşleşen tx `confirmed` olunca isteği gönderir ve aynı tx'i birden
// çok kez gönderebilir. Indexer yalnızca kesinleşmiş veri yazdığı için webhook bir bildirimdir: gövdeden
// yalnızca imzalar alınır, tx ve hesaplar kesinleşince RPC'den okunur (gövdenin içeriğine güvenilmez).
// Kesinleşmeyi bekleyen imzalar sınırlı bir kuyruktadır; dolan kuyruk ya da süresi geçen imza bırakılır,
// RPC taraması onu yine bulur. İstek, Helius'a verilen `Authorization` değeriyle doğrulanır (değerin
// SHA-256'sı yapılandırmadadır, sabit zamanlı karşılaştırma).
import { createHash } from 'node:crypto';
import type { Logger } from '@squaresdk/solana-observability';
import { safeEqual } from '@squaresdk/solana-hardening';
import type { Request, Response } from 'express';
import type { Chain } from './chain.js';
import type { IndexerMetrics } from './metrics.js';
import type { Pipeline } from './pipeline.js';

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export interface WebhookQueue {
  /** İmzaları kuyruğa ekler. */
  add(signatures: readonly string[]): { accepted: number; duplicate: number; dropped: number };
  /** Kuyruktaki imzaların durumuna bakar; kesinleşenleri işler. */
  drain(): Promise<{ indexed: number; waiting: number }>;
  size(): number;
}

export function createWebhookQueue(deps: {
  chain: Chain;
  pipeline: Pipeline;
  maxPending: number;
  pendingTtlSeconds: number;
  metrics: IndexerMetrics;
  log: Logger;
  clock?: () => number;
}): WebhookQueue {
  const { chain, pipeline, metrics, log } = deps;
  const clock = deps.clock ?? Date.now;
  /** İmza → kuyruğa giriş zamanı (ms). */
  let pending: ReadonlyMap<string, number> = new Map();

  const count = (result: string, n = 1) => {
    if (n > 0) metrics.webhookSignatures.inc({ result }, n);
  };

  /** Hata imzayı kuyrukta bırakır; bir sonraki boşaltmada yeniden denenir. */
  const processed = async (signature: string): Promise<boolean> => {
    try {
      return (await pipeline.process(signature)) !== 'pending';
    } catch (error) {
      metrics.errors.inc({ stage: 'webhook' });
      log.error('webhook_process_failed', { signature, error });
      return false;
    }
  };

  return {
    add(signatures) {
      const now = clock();
      const next = new Map(pending);
      let accepted = 0;
      let duplicate = 0;
      let dropped = 0;
      for (const signature of signatures) {
        if (next.has(signature)) duplicate += 1;
        else if (next.size >= deps.maxPending) dropped += 1;
        else {
          next.set(signature, now);
          accepted += 1;
        }
      }
      pending = next;
      count('accepted', accepted);
      count('duplicate', duplicate);
      count('dropped', dropped);
      metrics.webhookPending.set(pending.size);
      if (dropped > 0) log.warn('webhook_queue_full', { dropped, pending: pending.size });
      return { accepted, duplicate, dropped };
    },

    async drain() {
      const signatures = [...pending.keys()];
      if (signatures.length === 0) return { indexed: 0, waiting: 0 };
      const statuses = await chain.signatureStatuses(signatures);
      const now = clock();
      const done = new Set<string>();
      let indexed = 0;
      for (const [index, signature] of signatures.entries()) {
        const status = statuses[index] ?? null;
        if (status?.err) {
          done.add(signature);
          count('failed');
        } else if (status?.confirmationStatus === 'finalized' && (await processed(signature))) {
          done.add(signature);
          indexed += 1;
          count('indexed');
        } else if (now - pending.get(signature)! > deps.pendingTtlSeconds * 1000) {
          done.add(signature);
          count('expired');
        }
      }
      pending = new Map([...pending].filter(([signature]) => !done.has(signature)));
      metrics.webhookPending.set(pending.size);
      return { indexed, waiting: pending.size };
    },

    size: () => pending.size,
  };
}

/** Raw webhook gövdesindeki imzalar: her öğe `getTransaction` biçiminde bir tx'tir. */
export function webhookSignatures(body: unknown): string[] | null {
  if (!Array.isArray(body)) return null;
  const signatures: string[] = [];
  for (const item of body) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as { signature?: unknown; transaction?: { signatures?: unknown } };
    const signature =
      record.signature ??
      (Array.isArray(record.transaction?.signatures) ? record.transaction.signatures[0] : undefined);
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return null;
    signatures.push(signature);
  }
  return signatures;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** `POST /webhooks/helius`. Gövde `express.json` ile ayrıştırılmış olmalıdır. */
export function heliusWebhookHandler(deps: { authSha256: string; queue: WebhookQueue; log: Logger }) {
  return (req: Request, res: Response): void => {
    const authorization = req.get('authorization');
    if (!authorization || !safeEqual(sha256(authorization), deps.authSha256)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const signatures = webhookSignatures(req.body);
    if (!signatures) {
      deps.log.warn('webhook_invalid_body', {});
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    res.status(200).json(deps.queue.add(signatures));
  };
}
