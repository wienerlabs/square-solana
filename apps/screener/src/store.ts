// Denetim kaydı (`screening_decisions`) ve yenileme adayları. Her tarama kararı, sonucu ne olursa olsun
// bir satırdır. Yenileme adayları iki kaynaktan birleşir: screener'ın onaylanmış kararları (tx'ten sonra
// zincirden okunan `expires_at`) ve indexer'ın `ScreeningRecord` aynası (`screenings`). Biri geride kalsa
// (indexer gecikmesi, başka bir örneğin yazdığı kayıt) diğeri cüzdanı yine bulur; cüzdan başına en geç
// `expires_at` alınır. Aynaya yalnızca indexer yazar; screener okur (veri modeli §1).
import type { Prisma, PrismaClient, ScreeningDecisionModel } from '@squaresdk/solana-db';

export type DecisionRow = ScreeningDecisionModel;

export interface NewDecision {
  readonly wallet: string;
  readonly trigger: 'request' | 'renewal';
  readonly outcome: 'recorded' | 'sourceError' | 'txFailed';
  readonly status: 'clear' | 'flagged' | null;
  readonly sources: Prisma.InputJsonValue;
  readonly evidence: Prisma.InputJsonValue | null;
  readonly sourceHash: string | null;
  readonly signature: string | null;
  readonly slot: number | null;
  readonly screenedAt: number | null;
  readonly expiresAt: number | null;
  readonly error: string | null;
  readonly caller: string | null;
  readonly at: Date;
}

export interface RenewalCandidate {
  readonly wallet: string;
  readonly expiresAt: number;
}

export interface DecisionStore {
  insert(decision: NewDecision): Promise<DecisionRow>;
  /** Cüzdanın son onaylanmış kararı; yoksa null. */
  latestRecorded(wallet: string): Promise<DecisionRow | null>;
  /** Cüzdanın bütün kararları, yeniden eskiye. */
  history(wallet: string, page: { page: number; limit: number }): Promise<{ items: DecisionRow[]; total: number }>;
  /**
   * `expires_at`'ı `deadline`'a (Unix saniyesi) kadar olan cüzdanlar, en erken dolan önce. `since`'ten sonra
   * kararı yazılmış ya da denenmiş cüzdanlar atlanır (başarısız denemenin geri çekilmesi).
   */
  renewalCandidates(params: { deadline: number; since: Date; limit: number }): Promise<RenewalCandidate[]>;
}

export function createDecisionStore(db: PrismaClient): DecisionStore {
  return {
    insert: (decision) =>
      db.screeningDecision.create({
        data: {
          ...decision,
          evidence: decision.evidence ?? undefined,
          slot: decision.slot === null ? null : BigInt(decision.slot),
          screenedAt: decision.screenedAt === null ? null : BigInt(decision.screenedAt),
          expiresAt: decision.expiresAt === null ? null : BigInt(decision.expiresAt),
        },
      }),

    latestRecorded: (wallet) =>
      db.screeningDecision.findFirst({
        where: { wallet, outcome: 'recorded' },
        orderBy: [{ at: 'desc' }, { id: 'asc' }],
      }),

    async history(wallet, page) {
      const [items, total] = await Promise.all([
        db.screeningDecision.findMany({
          where: { wallet },
          orderBy: [{ at: 'desc' }, { id: 'asc' }],
          skip: (page.page - 1) * page.limit,
          take: page.limit,
        }),
        db.screeningDecision.count({ where: { wallet } }),
      ]);
      return { items, total };
    },

    async renewalCandidates({ deadline, since, limit }) {
      const rows = await db.$queryRaw<{ wallet: string; expires_at: bigint }[]>`
        SELECT known.wallet, MAX(known.expires_at) AS expires_at
        FROM (
          SELECT wallet, expires_at FROM screening_decisions WHERE outcome = 'recorded'
          UNION ALL
          SELECT wallet, expires_at FROM screenings
        ) AS known
        WHERE NOT EXISTS (
          SELECT 1 FROM screening_decisions recent WHERE recent.wallet = known.wallet AND recent.at > ${since}
        )
        GROUP BY known.wallet
        HAVING MAX(known.expires_at) <= ${BigInt(deadline)}
        ORDER BY 2, 1
        LIMIT ${limit}`;
      return rows.map((row) => ({ wallet: row.wallet, expiresAt: Number(row.expires_at) }));
    },
  };
}
