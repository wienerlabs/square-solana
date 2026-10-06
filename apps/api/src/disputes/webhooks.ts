// Arbitrator webhook abonelikleri (BE-22): kayıt, listeleme, silme. Yalnızca aktif arbitrator kaydeder. Sır
// Standard Webhooks biçimindedir (`whsec_…`, `@squaresdk/solana-hardening`), yalnızca oluşturma yanıtında bir kez
// döner ve veritabanında secret box'la şifreli durur (AAD: kaydın kimliği; başka kayda kopyalanan değer açılmaz).
// Uç adresi SSRF kurallarıyla denetlenir: https, kullanıcı bilgisiz, özel ağ adresi değil (çözümleme gönderimde
// yeniden denetlenir).
import { randomUUID } from 'node:crypto';
import type { ArbitrationEvent, ArbitrationWebhookModel as WebhookRow, PrismaClient } from '@squaresdk/solana-db';
import {
  SsrfError,
  assertSafeUrl,
  generateWebhookSecret,
  type SafeUrlPolicy,
  type SecretBox,
} from '@squaresdk/solana-hardening';
import {
  ArbitrationWebhookCreateSchema,
  ArbitrationWebhookSchema,
  type ArbitrationEventType,
  type ArbitrationWebhook,
  type ArbitrationWebhookCreated,
} from '@squaresdk/solana-types';
import { badRequest, conflict, forbidden, notFound, parse } from '../http.js';
import type { Arbitrators } from './arbitrators.js';

/** Bir arbitrator'ın en fazla aboneliği. */
export const MAX_WEBHOOKS_PER_WALLET = 10;

export const EVENT_TO_DB: Readonly<Record<ArbitrationEventType, ArbitrationEvent>> = {
  'dispute.raised': 'disputeRaised',
  'dispute.escalated': 'disputeEscalated',
  'dispute.vote': 'disputeVote',
  'dispute.decided': 'disputeDecided',
  'dispute.deadline': 'disputeDeadline',
};
export const EVENT_FROM_DB = Object.fromEntries(
  Object.entries(EVENT_TO_DB).map(([wire, db]) => [db, wire]),
) as Readonly<Record<ArbitrationEvent, ArbitrationEventType>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WebhookService {
  list(wallet: string): Promise<ArbitrationWebhook[]>;
  create(wallet: string, body: unknown): Promise<ArbitrationWebhookCreated>;
  remove(wallet: string, id: string): Promise<void>;
}

export const webhookView = (row: WebhookRow): ArbitrationWebhook =>
  ArbitrationWebhookSchema.parse({
    id: row.id,
    url: row.url,
    events: row.events.map((event) => EVENT_FROM_DB[event]),
    createdAt: Math.floor(row.createdAt.getTime() / 1000),
  });

export function createWebhookService(deps: {
  db: PrismaClient;
  box: SecretBox;
  arbitrators: Arbitrators;
  urlPolicy: SafeUrlPolicy;
}): WebhookService {
  const { db } = deps;
  return {
    async list(wallet) {
      const rows = await db.arbitrationWebhook.findMany({
        where: { wallet },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(webhookView);
    },

    async create(wallet, body) {
      const request = parse(ArbitrationWebhookCreateSchema, body, 'webhook aboneliği');
      if ((await deps.arbitrators.indexOf(wallet)) === null) {
        throw forbidden('webhook’u yalnızca aktif arbitrator kaydeder');
      }
      try {
        assertSafeUrl(request.url, deps.urlPolicy);
      } catch (error) {
        if (error instanceof SsrfError) throw badRequest(`webhook adresi kabul edilmiyor: ${error.message}`);
        throw error;
      }
      if ((await db.arbitrationWebhook.count({ where: { wallet } })) >= MAX_WEBHOOKS_PER_WALLET) {
        throw conflict(`bir arbitrator en çok ${MAX_WEBHOOKS_PER_WALLET} webhook kaydedebilir`);
      }
      if (await db.arbitrationWebhook.findUnique({ where: { wallet_url: { wallet, url: request.url } } })) {
        throw conflict('bu adres zaten kayıtlı; sırrı yenilemek için silip yeniden kaydedin');
      }
      const id = randomUUID();
      const secret = generateWebhookSecret();
      const row = await db.arbitrationWebhook.create({
        data: {
          id,
          wallet,
          url: request.url,
          events: [...new Set(request.events)].map((event) => EVENT_TO_DB[event]),
          secret: deps.box.seal(secret, id),
        },
      });
      return { webhook: webhookView(row), secret };
    },

    async remove(wallet, id) {
      const { count } = UUID.test(id)
        ? await db.arbitrationWebhook.deleteMany({ where: { id, wallet } })
        : { count: 0 };
      if (count === 0) throw notFound('webhook bulunamadı');
    },
  };
}
