// Keeper günlüğü (`keeper_actions`; API `GET /v1/keeper/actions`) ve aday seçimi. Her crank'in kayıtları
// talimatıyla (`action`) ayrılır; bir crank'in bekletmesi diğerini etkilemez.
// - Finalize: adaylar indexer'ın job aynasından gelir: `Delivered`, challenge penceresi bitmiş, hesabı açık.
//   Bekletilen job (son kaydı `nextAttemptAt` taşıyan) zamanı gelene kadar seçilmez; ancak beklediği şey
//   indexlendiyse beklemeden yeniden denenir: ispat bekleyen job'a ispat (`release_proofs`), screening bekleyen
//   job'a payee'nin kaydı (`screenings`) son denemeden sonra yazıldıysa. Böylece `ProofRequired` sürekli
//   denenmez ama ispat gelince gecikmeden ödenir.
// - Lapse (BE-22): adaylar dispute aynasından gelir: açık (`disputed`), son tarihi geçmiş, job hesabı açık; son
//   tarihi en eski önce. Son kaydı `nextAttemptAt` taşıyan dispute o zamana kadar seçilmez (onaylanan lapse de
//   bekleme taşır: ayna güncellenene kadar aynı işe yeniden gönderilmez).
// Birikim (`backlog`, yalnızca finalize): finalize edilebilir durumda bekleyen job'lar; keeper gecikmesinin ölçüsü. Challenge
// penceresi bitmiş, açık ve teslim edilmiş job, bir sebeple bekletilmiyorsa birikimdedir. İspat, screening ya
// da kârlılık beklemesi keeper'ın gecikmesi sayılmaz; ancak beklenen kayıt indexlendiyse job o andan itibaren
// yeniden birikimdedir. Onaylanmış finalize indexer aynayı güncelleyene kadar birikime girmez.
import type { KeeperActionKind, KeeperOutcome, KeeperReason, PrismaClient } from '@squaresdk/solana-db';

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

export interface Backlog {
  readonly due: number;
  /** En eski birikim kaydının finalize edilebilir olduğu an; birikim boşsa null. */
  readonly oldestReadyAt: Date | null;
}

export interface Journal {
  /** Bu turda değerlendirilecek job'lar (finalize: challenge'ı en erken biten önce). */
  candidates(now: Date, limit: number): Promise<Candidate[]>;
  /** Job'un bu talimattaki son kayıtlarından aynı sebeple ardışık bekletme ya da hata sayısı. */
  consecutive(job: string, reason: KeeperReason): Promise<number>;
  write(entry: JournalEntry, at: Date): Promise<void>;
}

/** Finalize crank'inin günlüğü: birikimi de ölçer. */
export interface FinalizeJournal extends Journal {
  /** Finalize edilebilir durumda bekleyen job'lar. */
  backlog(now: Date): Promise<Backlog>;
}

/** Ardışık sayımda bakılan en fazla kayıt (geri çekilme üst sınıra bundan önce ulaşır). */
const STREAK_WINDOW = 64;

/** Bir talimatın günlüğe yazımı ve ardışık sayımı. */
function actionLog(db: PrismaClient, action: KeeperActionKind): Omit<Journal, 'candidates'> {
  return {
    async consecutive(job, reason) {
      const recent = await db.keeperAction.findMany({
        where: { job, action },
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
          action,
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

export function createJournal(db: PrismaClient): FinalizeJournal {
  return {
    ...actionLog(db, 'finalizePayment'),
    async candidates(now, limit) {
      const seconds = BigInt(Math.floor(now.getTime() / 1000));
      const rows = await db.$queryRaw<{ job: string; reason: KeeperReason | null }[]>`
        SELECT j.address AS job, last.reason::text AS reason
        FROM jobs j
        LEFT JOIN LATERAL (
          SELECT k.reason, k.next_attempt_at, k.at FROM keeper_actions k
          WHERE k.job = j.address AND k.action = 'finalizePayment' ORDER BY k.at DESC, k.id DESC LIMIT 1
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

    async backlog(now) {
      const seconds = BigInt(Math.floor(now.getTime() / 1000));
      const [row] = await db.$queryRaw<{ due: number; oldest: Date | null }[]>`
        SELECT count(*)::int AS due, min(ready_at) AS oldest FROM (
          SELECT GREATEST(to_timestamp(j.challenge_end::double precision), wake.at) AS ready_at
          FROM jobs j
          LEFT JOIN LATERAL (
            SELECT k.outcome, k.reason, k.at FROM keeper_actions k
            WHERE k.job = j.address AND k.action = 'finalizePayment' ORDER BY k.at DESC, k.id DESC LIMIT 1
          ) last ON true
          LEFT JOIN LATERAL (
            SELECT max(woken.at) AS at FROM (
              SELECT r.indexed_at AS at FROM release_proofs r
              WHERE last.reason IN ('proofRequired', 'staleProof') AND r.job = j.address AND r.indexed_at > last.at
              UNION ALL
              SELECT s.indexed_at AS at FROM screenings s
              WHERE last.reason = 'screeningPending' AND s.indexed_at > last.at AND (s.wallet = j.agent_wallet
                OR s.wallet IN (SELECT c.buyer FROM claims c WHERE c.job = j.address AND c.buyer IS NOT NULL))
            ) woken
          ) wake ON true
          WHERE j.status = 'delivered' AND j.challenge_end <= ${seconds} AND j.closed_slot IS NULL
            AND (last.outcome IS NULL OR last.outcome <> 'confirmed')
            AND (last.reason IS NULL
              OR last.reason NOT IN ('proofRequired', 'staleProof', 'screeningPending', 'unprofitable')
              OR wake.at IS NOT NULL)
        ) due`;
      return { due: row?.due ?? 0, oldestReadyAt: row?.oldest ?? null };
    },
  };
}

/** Lapse crank'inin günlüğü: son tarihi geçmiş açık dispute'lar (BE-22). */
export function createLapseJournal(db: PrismaClient): Journal {
  return {
    ...actionLog(db, 'lapseDispute'),
    async candidates(now, limit) {
      const seconds = BigInt(Math.floor(now.getTime() / 1000));
      const rows = await db.$queryRaw<{ job: string; reason: KeeperReason | null }[]>`
        SELECT d.job AS job, last.reason::text AS reason
        FROM disputes d
        JOIN jobs j ON j.address = d.job AND j.closed_slot IS NULL
        LEFT JOIN LATERAL (
          SELECT k.reason, k.next_attempt_at FROM keeper_actions k
          WHERE k.job = d.job AND k.action = 'lapseDispute' ORDER BY k.at DESC, k.id DESC LIMIT 1
        ) last ON true
        WHERE d.job_status = 'disputed' AND d.deadline <= ${seconds}
          AND (last.next_attempt_at IS NULL OR last.next_attempt_at <= ${now})
        ORDER BY d.deadline ASC, d.job ASC
        LIMIT ${limit}`;
      return rows.map((row) => ({ job: row.job, lastReason: row.reason }));
    },
  };
}
