// Keeper günlüğü (`keeper_actions`; API `GET /v1/keeper/actions`) ve aday seçimi. Adaylar indexer'ın job
// aynasından gelir: `Delivered`, challenge penceresi bitmiş, hesabı açık. Bekletilen job (son kaydı
// `nextAttemptAt` taşıyan) zamanı gelene kadar seçilmez; ancak beklediği şey indexlendiyse beklemeden yeniden
// denenir: ispat bekleyen job'a ispat (`release_proofs`), screening bekleyen job'a payee'nin kaydı
// (`screenings`) son denemeden sonra yazıldıysa. Böylece `ProofRequired` sürekli denenmez ama ispat gelince
// gecikmeden ödenir.
import type { KeeperOutcome, KeeperReason, PrismaClient } from '@squaresdk/solana-db';

export interface Candidate {
  readonly job: string;
  /** Job'un son günlük kaydının sebebi ve sırası (ardışık bekletme sayısı); kayıt yoksa null. */
  readonly lastReason: KeeperReason | null;
}

export interface JournalEntry {
  readonly job: string;
  readonly outcome: KeeperOutcome;
  readonly reason: KeeperReason | null;
  readonly signature?: string | null;
  readonly keeperFee?: bigint | null;
  readonly nextAttemptAt?: Date | null;
}

export interface Journal {
  /** Bu turda değerlendirilecek job'lar, challenge'ı en erken biten önce. */
  candidates(now: Date, limit: number): Promise<Candidate[]>;
  /** Job'un son kayıtlarından aynı sebeple ardışık bekletme ya da hata sayısı. */
  consecutive(job: string, reason: KeeperReason): Promise<number>;
  write(entry: JournalEntry, at: Date): Promise<void>;
}

/** Ardışık sayımda bakılan en fazla kayıt (geri çekilme üst sınıra bundan önce ulaşır). */
const STREAK_WINDOW = 64;

export function createJournal(db: PrismaClient): Journal {
  return {
    async candidates(now, limit) {
      const seconds = BigInt(Math.floor(now.getTime() / 1000));
      const rows = await db.$queryRaw<{ job: string; reason: KeeperReason | null }[]>`
        SELECT j.address AS job, last.reason::text AS reason
        FROM jobs j
        LEFT JOIN LATERAL (
          SELECT k.reason, k.next_attempt_at, k.at FROM keeper_actions k
          WHERE k.job = j.address ORDER BY k.at DESC, k.id DESC LIMIT 1
        ) last ON true
        WHERE j.status = 'delivered' AND j.challenge_end <= ${seconds} AND j.closed_slot IS NULL
          AND (
            last.next_attempt_at IS NULL OR last.next_attempt_at <= ${now}
            OR (last.reason IN ('proofRequired', 'staleProof') AND EXISTS (
              SELECT 1 FROM release_proofs r WHERE r.job = j.address AND r.indexed_at > last.at))
            OR (last.reason = 'screeningPending' AND EXISTS (
              SELECT 1 FROM screenings s
              WHERE s.indexed_at > last.at AND (s.wallet = j.agent_wallet OR s.wallet IN (
                SELECT c.buyer FROM claims c WHERE c.job = j.address AND c.buyer IS NOT NULL))))
          )
        ORDER BY j.challenge_end ASC, j.address ASC
        LIMIT ${limit}`;
      return rows.map((row) => ({ job: row.job, lastReason: row.reason }));
    },

    async consecutive(job, reason) {
      const recent = await db.keeperAction.findMany({
        where: { job },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: STREAK_WINDOW,
        select: { reason: true },
      });
      const streak = recent.findIndex((entry) => entry.reason !== reason);
      return streak === -1 ? recent.length : streak;
    },

    async write(entry, at) {
      await db.keeperAction.create({
        data: {
          job: entry.job,
          action: 'finalizePayment',
          outcome: entry.outcome,
          reason: entry.reason,
          signature: entry.signature ?? null,
          keeperFee: entry.keeperFee === undefined || entry.keeperFee === null ? null : entry.keeperFee.toString(),
          at,
          nextAttemptAt: entry.nextAttemptAt ?? null,
        },
      });
    },
  };
}
