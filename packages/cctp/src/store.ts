// `cctp_transfers` deposu. Satırı kayıtta API yazar (`create`), sonra yalnızca relayer günceller (tek örnek
// keeper); bu yüzden güncellemeler satır kilidi istemez. Görünüm (`toView`) sözleşmedeki `CctpTransfer`'dır.
import type { CctpTransferStatus as DbStatus, PrismaClient } from '@squaresdk/solana-db';
import type { CctpTransfer, CctpTransferQuery, CctpTransferStatus } from '@squaresdk/solana-types';

/** Relayer'ın izlediği durumlar; `funded` ve `failed` son durumdur. */
export const OPEN_STATUSES = ['pendingAttestation', 'attested', 'received'] as const satisfies CctpTransferStatus[];

export interface TransferRow {
  readonly id: string;
  readonly sourceDomain: number;
  readonly sourceTxHash: string;
  readonly job: string;
  readonly institution: string;
  readonly mintRecipient: string;
  readonly status: CctpTransferStatus;
  readonly nonce: string | null;
  readonly message: string | null;
  readonly attestation: string | null;
  readonly amount: bigint | null;
  readonly feeExecuted: bigint | null;
  readonly attestedAt: Date | null;
  readonly receiveSignature: string | null;
  readonly fundSignature: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewTransfer {
  readonly sourceDomain: number;
  readonly sourceTxHash: string;
  readonly job: string;
  readonly institution: string;
  readonly mintRecipient: string;
}

/** Relayer'ın bir satıra yazdığı değişiklik; verilmeyen alan değişmez. */
export interface TransferPatch {
  readonly status?: CctpTransferStatus;
  readonly nonce?: string;
  readonly message?: string;
  readonly attestation?: string;
  readonly amount?: bigint;
  readonly feeExecuted?: bigint;
  readonly attestedAt?: Date;
  readonly receiveSignature?: string | null;
  readonly fundSignature?: string | null;
  readonly attempts?: number;
  readonly nextAttemptAt?: Date | null;
  readonly error?: string | null;
}

export interface TransferStore {
  /** Yeni kayıt; aynı kaynak tx'i zaten kayıtlıysa null (çağıran var olanı okur). */
  create(transfer: NewTransfer): Promise<TransferRow | null>;
  find(id: string): Promise<TransferRow | null>;
  findBySource(sourceDomain: number, sourceTxHash: string): Promise<TransferRow | null>;
  list(
    query: CctpTransferQuery,
    page: { page: number; limit: number },
  ): Promise<{ items: TransferRow[]; total: number }>;
  /** Zamanı gelmiş açık transferler: bir sonraki bakışı geçmiş ya da hiç bakılmamış, en eski önce. */
  due(now: Date, limit: number): Promise<TransferRow[]>;
  update(id: string, patch: TransferPatch): Promise<TransferRow>;
  /** Açık transferlerin duruma göre sayısı (metrik). */
  openCounts(): Promise<Record<(typeof OPEN_STATUSES)[number], number>>;
}

type DbRow = Awaited<ReturnType<PrismaClient['cctpTransfer']['findUniqueOrThrow']>>;

const toRow = (row: DbRow): TransferRow => ({
  id: row.id,
  sourceDomain: row.sourceDomain,
  sourceTxHash: row.sourceTxHash,
  job: row.job,
  institution: row.institution,
  mintRecipient: row.mintRecipient,
  status: row.status,
  nonce: row.nonce,
  message: row.message,
  attestation: row.attestation,
  amount: row.amount === null ? null : BigInt(row.amount.toFixed()),
  feeExecuted: row.feeExecuted === null ? null : BigInt(row.feeExecuted.toFixed()),
  attestedAt: row.attestedAt,
  receiveSignature: row.receiveSignature,
  fundSignature: row.fundSignature,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt,
  error: row.error,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Prisma'nın tekillik ihlali (P2002). */
const isUniqueViolation = (error: unknown) => (error as { code?: unknown }).code === 'P2002';

export function createTransferStore(db: PrismaClient): TransferStore {
  return {
    async create(transfer) {
      try {
        return toRow(await db.cctpTransfer.create({ data: { ...transfer, status: 'pendingAttestation' } }));
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    async find(id) {
      const row = await db.cctpTransfer.findUnique({ where: { id } });
      return row && toRow(row);
    },

    async findBySource(sourceDomain, sourceTxHash) {
      const row = await db.cctpTransfer.findUnique({
        where: { sourceDomain_sourceTxHash: { sourceDomain, sourceTxHash } },
      });
      return row && toRow(row);
    },

    async list(query, { page, limit }) {
      const where = {
        ...(query.job && { job: query.job }),
        ...(query.institution && { institution: query.institution }),
        ...(query.status && { status: query.status as DbStatus }),
      };
      const [rows, total] = await Promise.all([
        db.cctpTransfer.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        db.cctpTransfer.count({ where }),
      ]);
      return { items: rows.map(toRow), total };
    },

    async due(now, limit) {
      const rows = await db.cctpTransfer.findMany({
        where: {
          status: { in: [...OPEN_STATUSES] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      });
      return rows.map(toRow);
    },

    async update(id, patch) {
      const { amount, feeExecuted, ...rest } = patch;
      const data = {
        ...rest,
        ...(amount !== undefined && { amount: amount.toString() }),
        ...(feeExecuted !== undefined && { feeExecuted: feeExecuted.toString() }),
      };
      return toRow(await db.cctpTransfer.update({ where: { id }, data }));
    },

    async openCounts() {
      const groups = await db.cctpTransfer.groupBy({
        by: ['status'],
        where: { status: { in: [...OPEN_STATUSES] } },
        _count: { _all: true },
      });
      const counts = { pendingAttestation: 0, attested: 0, received: 0 };
      for (const group of groups) counts[group.status as keyof typeof counts] = group._count._all;
      return counts;
    },
  };
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

/** Sözleşmedeki görünüm (`CctpTransfer`). */
export function toView(row: TransferRow): CctpTransfer {
  return {
    id: row.id,
    sourceDomain: row.sourceDomain,
    sourceTxHash: row.sourceTxHash,
    job: row.job,
    institution: row.institution,
    mintRecipient: row.mintRecipient,
    status: row.status,
    nonce: row.nonce,
    message: row.message,
    attestation: row.attestation,
    amount: row.amount?.toString() ?? null,
    feeExecuted: row.feeExecuted?.toString() ?? null,
    minted: row.amount === null || row.feeExecuted === null ? null : (row.amount - row.feeExecuted).toString(),
    attestedAt: row.attestedAt && seconds(row.attestedAt),
    receiveSignature: row.receiveSignature,
    fundSignature: row.fundSignature,
    error: row.error,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt && seconds(row.nextAttemptAt),
    createdAt: seconds(row.createdAt),
    updatedAt: seconds(row.updatedAt),
  };
}
