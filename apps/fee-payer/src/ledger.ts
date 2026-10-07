// Kalıcı bütçe ve maliyet günlüğü (`sponsored_txs`, ADR 0019). Kullanıcı (cüzdan) başına ve servis toplamında
// günlük lamport bütçesi: UTC günü içinde, başarısız gönderimler hariç ücret + rent toplamı. Denetim ve kayıt
// tek veritabanı işleminde, işlem boyunca tutulan bir advisory kilidiyle yapılır: eşzamanlı istekler (servisin
// birden çok örneği dahil) bütçeyi birlikte aşamaz.
import type { PrismaClient } from '@squaresdk/solana-db';

/** Fee payer'ın advisory kilidi (`pg_advisory_xact_lock`): sabit, servise özgü 64 bit anahtar. */
const LOCK_KEY = 0x5351_4645_4550_4159n; // "SQFEEPAY"
const MS_PER_DAY = 86_400_000;

export interface SponsoredEntry {
  readonly signature: string;
  readonly wallet: string;
  readonly apiKeyId: string | null;
  readonly feeLamports: bigint;
  readonly rentLamports: bigint;
  readonly computeUnits: number | null;
  readonly computeUnitLimit: number;
  readonly computeUnitPrice: bigint;
  readonly instructions: readonly string[];
}

export type Reservation =
  | {
      readonly ok: true;
      readonly userSpent: bigint;
      readonly userLimit: bigint;
      readonly replayed: 'signed' | 'submitted' | null;
    }
  | {
      readonly ok: false;
      readonly scope: 'user' | 'global';
      readonly spent: bigint;
      readonly limit: bigint;
    };

export interface Usage {
  /** UTC günü (YYYY-MM-DD). */
  readonly day: string;
  readonly spentLamports: bigint;
  readonly limitLamports: bigint;
  readonly transactions: number;
}

export interface Ledger {
  /** Bütçe yetiyorsa tx'i `signed` olarak kaydeder; yetmiyorsa kaydetmez. */
  reserve(entry: SponsoredEntry): Promise<Reservation>;
  markSubmitted(signature: string): Promise<void>;
  usage(wallet: string): Promise<Usage>;
}

/** Günün başı (UTC). */
export const dayStart = (now: number) => new Date(Math.floor(now / MS_PER_DAY) * MS_PER_DAY);

const toBigInt = (value: { toFixed(): string } | null | undefined) => BigInt(value?.toFixed() ?? '0');

export function createLedger(deps: {
  db: PrismaClient;
  userDailyLamports: bigint;
  globalDailyLamports: bigint;
  clock?: () => number;
}): Ledger {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;

  type Client = Pick<PrismaClient, 'sponsoredTx'>;
  async function spent(client: Client, since: Date, wallet: string | null) {
    const result = await client.sponsoredTx.aggregate({
      where: { createdAt: { gte: since }, status: { not: 'failed' }, ...(wallet === null ? {} : { wallet }) },
      _sum: { feeLamports: true, rentLamports: true },
      _count: { _all: true },
    });
    return {
      lamports: toBigInt(result._sum.feeLamports) + toBigInt(result._sum.rentLamports),
      count: result._count._all,
    };
  }

  return {
    reserve(entry) {
      const cost = entry.feeLamports + entry.rentLamports;
      return db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        const since = dayStart(clock());
        const existing = await tx.sponsoredTx.findUnique({
          where: { signature: entry.signature },
          select: { wallet: true, status: true },
        });
        if (existing && existing.status !== 'failed') {
          const owner = await spent(tx, since, existing.wallet);
          return {
            ok: true,
            userSpent: owner.lamports,
            userLimit: deps.userDailyLamports,
            replayed: existing.status,
          } as const;
        }
        const user = await spent(tx, since, entry.wallet);
        if (user.lamports + cost > deps.userDailyLamports) {
          return { ok: false, scope: 'user', spent: user.lamports, limit: deps.userDailyLamports } as const;
        }
        const total = await spent(tx, since, null);
        if (total.lamports + cost > deps.globalDailyLamports) {
          return { ok: false, scope: 'global', spent: total.lamports, limit: deps.globalDailyLamports } as const;
        }
        const row = {
          wallet: entry.wallet,
          apiKeyId: entry.apiKeyId,
          status: 'signed' as const,
          error: null,
          feeLamports: entry.feeLamports.toString(),
          rentLamports: entry.rentLamports.toString(),
          computeUnits: entry.computeUnits,
          computeUnitLimit: entry.computeUnitLimit,
          computeUnitPrice: entry.computeUnitPrice.toString(),
          instructions: [...entry.instructions],
          createdAt: new Date(clock()),
        };
        await (existing
          ? tx.sponsoredTx.update({ where: { signature: entry.signature }, data: row })
          : tx.sponsoredTx.create({ data: { signature: entry.signature, ...row } }));
        return {
          ok: true,
          userSpent: user.lamports + cost,
          userLimit: deps.userDailyLamports,
          replayed: null,
        } as const;
      });
    },

    async markSubmitted(signature) {
      await db.sponsoredTx.update({ where: { signature }, data: { status: 'submitted' } });
    },

    async usage(wallet) {
      const since = dayStart(clock());
      const { lamports, count } = await spent(db, since, wallet);
      return {
        day: since.toISOString().slice(0, 10),
        spentLamports: lamports,
        limitLamports: deps.userDailyLamports,
        transactions: count,
      };
    },
  };
}
