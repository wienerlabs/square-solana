// x402 ücretli uç nokta tanımları ve kullanımı (FE-22, ADR 0023). Tanım cüzdana aittir; ödemeyi geliştiricinin
// sunucusu ister (`@squaresdk/solana-x402` `paidRouteFromDefinition`) ve uzlaştırdığı her ödemeyi bildirir
// (`recordX402Payment`). Square ödeme yolunda değildir: kayıt geliştiricinin bildirimidir, ödeme işlemi
// (`transaction`) zincirde doğrulanabilir.
// - Yol cüzdan başına tekildir; aynı yolda ikinci tanım 409.
// - Ödeme ödeme yükünün kimliğiyle (`fingerprint`, tekrar korumasının kimliği) ve işlem imzasıyla ağ başına bir
//   kez sayılır. Aynı ödemenin aynı tanıma yeniden bildirimi ilk kaydı döner; başka bir tanıma ya da farklı
//   işlemle bildirimi 409.
// - Bildirilen ödemenin ağı, mint'i ve alıcısı tanımınkiyle aynı olmalıdır; tutar bildirildiği gibidir (fiyat
//   sonradan değişmiş olabilir).
import type { Prisma, PrismaClient, X402Network as DbNetwork } from '@squaresdk/solana-db';
import {
  X402_RECENT_PAYMENTS,
  type X402Endpoint,
  type X402EndpointCreate,
  type X402EndpointUpdate,
  type X402EndpointUsage,
  type X402Network,
  type X402Payment,
  type X402PaymentReport,
} from '@squaresdk/solana-types';
import { HttpError, badRequest, notFound } from './http.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const NETWORK_TO_DB: Readonly<Record<X402Network, DbNetwork>> = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'mainnet',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'testnet',
};
const NETWORK_FROM_DB = Object.fromEntries(Object.entries(NETWORK_TO_DB).map(([wire, db]) => [db, wire])) as Readonly<
  Record<DbNetwork, X402Network>
>;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const conflict = (message: string) => new HttpError(409, 'conflict', message);

/** Benzersizlik ihlali (Prisma P2002). */
const isUniqueViolation = (error: unknown) => (error as { code?: unknown }).code === 'P2002';

type EndpointRow = Prisma.X402EndpointGetPayload<object>;
type PaymentRow = Prisma.X402PaymentGetPayload<object>;

const endpointView = (row: EndpointRow): X402Endpoint => ({
  id: row.id,
  name: row.name,
  path: row.path,
  description: row.description,
  amount: row.amount.toFixed(),
  mint: row.mint,
  network: NETWORK_FROM_DB[row.network],
  payTo: row.payTo,
  enabled: row.enabled,
  createdAt: seconds(row.createdAt),
  updatedAt: seconds(row.updatedAt),
});

const paymentView = (row: PaymentRow): X402Payment => ({
  id: row.id,
  endpointId: row.endpointId,
  fingerprint: row.fingerprint,
  transaction: row.transaction,
  network: NETWORK_FROM_DB[row.network],
  asset: row.asset,
  amount: row.amount.toFixed(),
  payer: row.payer,
  payTo: row.payTo,
  settledAt: seconds(row.settledAt),
  reportedAt: seconds(row.reportedAt),
});

export interface X402EndpointService {
  list(wallet: string): Promise<X402Endpoint[]>;
  create(wallet: string, body: X402EndpointCreate): Promise<X402Endpoint>;
  get(wallet: string, id: string): Promise<X402Endpoint>;
  update(wallet: string, id: string, body: X402EndpointUpdate): Promise<X402Endpoint>;
  remove(wallet: string, id: string): Promise<void>;
  usage(wallet: string, id: string): Promise<X402EndpointUsage>;
  /** `created: false`: aynı ödeme bu tanıma daha önce bildirilmiş, ilk kayıt döner. */
  recordPayment(
    wallet: string,
    id: string,
    report: X402PaymentReport,
  ): Promise<{ payment: X402Payment; created: boolean }>;
}

export function createX402EndpointService(deps: { db: PrismaClient }): X402EndpointService {
  const { db } = deps;

  const owned = async (wallet: string, id: string): Promise<EndpointRow> => {
    const row = UUID.test(id) ? await db.x402Endpoint.findFirst({ where: { id, wallet } }) : null;
    if (!row) throw notFound('ücretli uç nokta bulunamadı');
    return row;
  };

  const uniquePath = async <T>(write: () => Promise<T>): Promise<T> => {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('bu yolda başka bir ücretli uç nokta var');
      throw error;
    }
  };

  /** Aynı ödemenin önceki kaydı: aynı tanım ve işlemse ilk kayıt, değilse 409. */
  const previous = async (
    wallet: string,
    endpointId: string,
    report: X402PaymentReport,
  ): Promise<X402Payment | null> => {
    const network = NETWORK_TO_DB[report.network];
    const row = await db.x402Payment.findFirst({
      where: { wallet, network, OR: [{ fingerprint: report.fingerprint }, { transaction: report.transaction }] },
    });
    if (!row) return null;
    if (
      row.endpointId !== endpointId ||
      row.fingerprint !== report.fingerprint ||
      row.transaction !== report.transaction
    ) {
      throw conflict('bu ödeme başka bir kayıtla bildirilmiş');
    }
    return paymentView(row);
  };

  return {
    async list(wallet) {
      const rows = await db.x402Endpoint.findMany({ where: { wallet }, orderBy: { createdAt: 'desc' } });
      return rows.map(endpointView);
    },

    async create(wallet, body) {
      const row = await uniquePath(() =>
        db.x402Endpoint.create({
          data: { wallet, ...body, network: NETWORK_TO_DB[body.network] },
        }),
      );
      return endpointView(row);
    },

    async get(wallet, id) {
      return endpointView(await owned(wallet, id));
    },

    async update(wallet, id, body) {
      await owned(wallet, id);
      // Verilmeyen alan `undefined`'dır; Prisma onu değiştirmez.
      const { network, ...rest } = body;
      const row = await uniquePath(() =>
        db.x402Endpoint.update({
          where: { id },
          data: { ...rest, ...(network === undefined ? {} : { network: NETWORK_TO_DB[network] }) },
        }),
      );
      return endpointView(row);
    },

    async remove(wallet, id) {
      const removed = UUID.test(id) ? await db.x402Endpoint.deleteMany({ where: { id, wallet } }) : { count: 0 };
      if (removed.count !== 1) throw notFound('ücretli uç nokta bulunamadı');
    },

    async usage(wallet, id) {
      await owned(wallet, id);
      const [groups, recent] = await Promise.all([
        db.x402Payment.groupBy({
          by: ['network', 'asset'],
          where: { endpointId: id },
          _sum: { amount: true },
          _count: { _all: true },
          _max: { settledAt: true },
          orderBy: [{ network: 'asc' }, { asset: 'asc' }],
        }),
        db.x402Payment.findMany({
          where: { endpointId: id },
          orderBy: [{ settledAt: 'desc' }, { reportedAt: 'desc' }],
          take: X402_RECENT_PAYMENTS,
        }),
      ]);
      const last = groups.reduce<Date | null>(
        (latest, group) =>
          group._max.settledAt && (!latest || group._max.settledAt > latest) ? group._max.settledAt : latest,
        null,
      );
      return {
        endpointId: id,
        payments: groups.reduce((count, group) => count + group._count._all, 0),
        totals: groups.map((group) => ({
          network: NETWORK_FROM_DB[group.network],
          asset: group.asset,
          amount: group._sum.amount?.toFixed() ?? '0',
          payments: group._count._all,
        })),
        lastPaidAt: last ? seconds(last) : null,
        recent: recent.map(paymentView),
      };
    },

    async recordPayment(wallet, id, report) {
      const endpoint = await owned(wallet, id);
      const mismatched = [
        NETWORK_TO_DB[report.network] !== endpoint.network && 'network',
        report.asset !== endpoint.mint && 'asset',
        report.payTo !== endpoint.payTo && 'payTo',
      ].filter((field): field is string => field !== false);
      if (mismatched.length > 0) {
        throw badRequest('ödeme tanımın ağı, mint’i ya da alıcısıyla uyuşmuyor', { fields: mismatched });
      }
      const existing = await previous(wallet, id, report);
      if (existing) return { payment: existing, created: false };
      try {
        const row = await db.x402Payment.create({
          data: {
            endpointId: id,
            wallet,
            fingerprint: report.fingerprint,
            transaction: report.transaction,
            network: NETWORK_TO_DB[report.network],
            asset: report.asset,
            amount: report.amount,
            payer: report.payer,
            payTo: report.payTo,
            settledAt: new Date(report.settledAt * 1000),
          },
        });
        return { payment: paymentView(row), created: true };
      } catch (error) {
        // Eşzamanlı aynı bildirim: kazanan kayıt döner.
        if (!isUniqueViolation(error)) throw error;
        const raced = await previous(wallet, id, report);
        if (!raced) throw error;
        return { payment: raced, created: false };
      }
    },
  };
}
