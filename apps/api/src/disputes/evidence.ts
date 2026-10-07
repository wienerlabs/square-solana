// Dispute kanıtı (BE-22): `reason_hash` ↔ zincir dışı kanıt. İçeriğin SHA-256'sı `reasonHash`'tir; kurum kanıtı
// `raise_dispute`'tan önce yükler ve dönen hash'i argüman olarak verir. Karşı taraf (agent cüzdanı / sahibi) ve
// arbitrator'lar dispute açıldıktan sonra kanıt ekler. İçerik özel kovada `<job>/<hash>` anahtarıyla durur;
// okuyan yine bu üç taraftır. Aynı job'a aynı içerik ikinci kez yüklenirse ilk kayıt döner (yükleyen değişmez).
import { createHash } from 'node:crypto';
import type { DisputeEvidenceModel as EvidenceRow, PrismaClient } from '@squaresdk/solana-db';
import { DisputeEvidenceSchema, type DisputeEvidence } from '@squaresdk/solana-types';
import type { Caller } from '../caller.js';
import { conflict, forbidden, notFound } from '../http.js';
import type { EvidenceStore } from '../storage.js';
import type { JobParties, Parties } from './parties.js';

export interface EvidenceService {
  upload(params: { caller: Caller; job: string; content: Buffer; contentType: string }): Promise<DisputeEvidence>;
  list(params: { caller: Caller; job: string }): Promise<DisputeEvidence[]>;
  content(params: { caller: Caller; job: string; id: string }): Promise<{ contentType: string; content: Buffer }>;
}

/** Kurumun dispute açmadan önce de yükleyebildiği durumlar (`raise_dispute` teslim edilmiş işte açılır). */
const INSTITUTION_STATUSES = new Set(['delivered', 'disputed', 'resolved']);
/** Dispute'un taraflarca görüldüğü durumlar. */
const DISPUTE_STATUSES = new Set(['disputed', 'resolved']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function evidenceView(row: EvidenceRow, disputeReasonHash: string | null): DisputeEvidence {
  return DisputeEvidenceSchema.parse({
    id: row.id,
    job: row.job,
    reasonHash: row.contentHash,
    contentType: row.contentType,
    size: Number(row.byteSize),
    role: row.role,
    uploadedBy: row.uploadedBy,
    isDisputeReason: row.contentHash === disputeReasonHash,
    createdAt: seconds(row.createdAt),
  });
}

export async function evidenceOf(db: PrismaClient, job: string): Promise<DisputeEvidence[]> {
  const [rows, dispute] = await Promise.all([
    db.disputeEvidence.findMany({ where: { job }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.dispute.findUnique({ where: { job }, select: { reasonHash: true } }),
  ]);
  return rows.map((row) => evidenceView(row, dispute?.reasonHash ?? null));
}

export function createEvidenceService(deps: {
  db: PrismaClient;
  store: EvidenceStore;
  parties: Parties;
}): EvidenceService {
  const { db, store, parties } = deps;

  async function jobOf(job: string): Promise<JobParties & { status: string }> {
    const row = await db.job.findUnique({
      where: { address: job },
      select: { address: true, institution: true, agentRecord: true, agentWallet: true, status: true },
    });
    if (!row) throw notFound('job bulunamadı');
    return row;
  }

  /** Zincirdeki dispute'un `reasonHash`'i; dispute yoksa null. */
  async function reasonHashOf(job: string): Promise<string | null> {
    const dispute = await db.dispute.findUnique({ where: { job }, select: { reasonHash: true } });
    return dispute?.reasonHash ?? null;
  }

  async function reader(caller: Caller, job: string) {
    const row = await jobOf(job);
    const role = await parties.roleOf(caller, row, 'read');
    if (!role) throw forbidden('kanıtı yalnızca kurum, agent cüzdanı / sahibi ve aktif arbitrator’lar okur');
    return row;
  }

  return {
    async upload({ caller, job, content, contentType }) {
      const row = await jobOf(job);
      const role = await parties.roleOf(caller, row, 'upload');
      if (!role) throw forbidden('kanıtı yalnızca kurum, agent cüzdanı / sahibi ve aktif arbitrator’lar yükler');
      const allowed = role === 'institution' ? INSTITUTION_STATUSES : DISPUTE_STATUSES;
      if (!allowed.has(row.status)) {
        throw conflict(
          role === 'institution'
            ? `job ${row.status} durumunda; kanıt teslimden sonra yüklenir`
            : `job ${row.status} durumunda; ${role} kanıtı dispute açıldıktan sonra yüklenir`,
        );
      }
      const contentHash = createHash('sha256').update(content).digest('hex');
      const existing = await db.disputeEvidence.findUnique({ where: { job_contentHash: { job, contentHash } } });
      if (existing) return evidenceView(existing, await reasonHashOf(job));
      const storageKey = `${job}/${contentHash}`;
      await store.put(storageKey, content, contentType);
      const data = {
        job,
        contentHash,
        contentType,
        byteSize: BigInt(content.length),
        storageKey,
        role,
        uploadedBy: caller.wallet,
      };
      // Eşzamanlı aynı yükleme: ilk yazılan kayıt kalır.
      const created = await db.disputeEvidence.upsert({
        where: { job_contentHash: { job, contentHash } },
        create: data,
        update: {},
      });
      return evidenceView(created, await reasonHashOf(job));
    },

    async list({ caller, job }) {
      await reader(caller, job);
      return evidenceOf(db, job);
    },

    async content({ caller, job, id }) {
      await reader(caller, job);
      const row = UUID.test(id) ? await db.disputeEvidence.findFirst({ where: { id, job } }) : null;
      if (!row) throw notFound('kanıt bulunamadı');
      const content = await store.get(row.storageKey);
      if (!content) throw notFound('kanıtın içeriği depoda yok');
      return { contentType: row.contentType, content };
    },
  };
}
