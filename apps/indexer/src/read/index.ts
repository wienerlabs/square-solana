// Okuma API'si (`@squaresdk/solana-indexer/read`): indexer'ın yazdığı tablolardan API sözleşmesinin okuma
// görünümleri (`listJobs`, `getJob` … `listEvents`). HTTP, zarf ve yetki API'nindir (BE-18); bu modül
// filtreleri doğrular, sayfalar ve görünümleri üretir.
// - Kapanmış hesaplar (`closedSlot` dolu job ve alacaklar) dönmez: görünüm zincirin güncel durumudur.
// - Sıralama: job'lar oluşturulma zamanı, dispute'lar açılma zamanı, diğer listeler son değişiklik slot'u
//   yeniden eskiye; eşitlikte adres. Event'ler eskiden yeniye (slot, imza, talimat, event): akış okuması.
import { squareIdentity } from '@squaresdk/solana-identity';
import type { PrismaClient } from '@squaresdk/solana-db';
import {
  Address,
  AgentStatusSchema,
  ClaimStatusSchema,
  JobStatusSchema,
  type AgentView,
  type ClaimView,
  type DisputeView,
  type IndexedEvent,
  type InstitutionView,
  type JobView,
  type PolicyView,
  type ScreeningView,
} from '@squaresdk/solana-types';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import {
  agentView,
  claimView,
  disputeView,
  eventView,
  institutionView,
  jobView,
  policyView,
  screeningView,
  unixSeconds,
} from './views.js';

/** Sayfa: OpenAPI `page` (1'den) ve `limit` (1–200). */
const PageSchema = z.object({ page: z.number().int().min(1), limit: z.number().int().min(1).max(200) });
export type Page = z.infer<typeof PageSchema>;

export interface PageResult<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly limit: number;
}

const JobFilterSchema = z.object({
  status: JobStatusSchema.optional(),
  institution: Address.optional(),
  agentRecord: Address.optional(),
  policy: Address.optional(),
});
const PolicyFilterSchema = z.object({ institution: Address.optional(), active: z.boolean().optional() });
const AgentFilterSchema = z.object({
  owner: Address.optional(),
  status: AgentStatusSchema.optional(),
  skill: z.string().min(1).max(64).optional(),
});
const ClaimFilterSchema = z.object({
  status: ClaimStatusSchema.optional(),
  seller: Address.optional(),
  buyer: Address.optional(),
});
const DisputeFilterSchema = z.object({ jobStatus: JobStatusSchema.optional() });
const EventFilterSchema = z.object({
  job: Address.optional(),
  program: z.enum(['registry', 'policy', 'verifier', 'escrow']).optional(),
  name: z.string().min(1).max(64).optional(),
  fromSlot: z.number().int().min(0).optional(),
});

export type JobFilter = z.infer<typeof JobFilterSchema>;
export type PolicyFilter = z.infer<typeof PolicyFilterSchema>;
export type AgentFilter = z.infer<typeof AgentFilterSchema>;
export type ClaimFilter = z.infer<typeof ClaimFilterSchema>;
export type DisputeFilter = z.infer<typeof DisputeFilterSchema>;
export type EventFilter = z.infer<typeof EventFilterSchema>;

export interface ReadApi {
  listJobs(filter: JobFilter, page: Page): Promise<PageResult<JobView>>;
  getJob(job: string): Promise<JobView | null>;
  getInstitution(institution: string): Promise<InstitutionView | null>;
  listPolicies(filter: PolicyFilter, page: Page): Promise<PageResult<PolicyView>>;
  getPolicy(policy: string): Promise<PolicyView | null>;
  listAgents(filter: AgentFilter, page: Page): Promise<PageResult<AgentView>>;
  getAgent(agentRecord: string): Promise<AgentView | null>;
  listClaims(filter: ClaimFilter, page: Page): Promise<PageResult<ClaimView>>;
  /** Job'un açık alacak listelemesi. */
  getClaim(job: string): Promise<ClaimView | null>;
  listDisputes(filter: DisputeFilter, page: Page): Promise<PageResult<DisputeView>>;
  getDispute(job: string): Promise<DisputeView | null>;
  getScreening(wallet: string): Promise<ScreeningView | null>;
  listEvents(filter: EventFilter, page: Page): Promise<PageResult<IndexedEvent>>;
}

const pageWindow = (page: Page) => ({ skip: (page.page - 1) * page.limit, take: page.limit });
const parseAddress = (value: string) => Address.parse(value);

export function createReadApi(deps: {
  db: PrismaClient;
  /** did:aip v2 Solana ağ referansı (genesis hash'inin ilk 32 karakteri; `CHAIN_REFS`). */
  chainRef: string;
  /** square_registry program kimliği (DID'in kayıt segmenti). */
  registryProgramId: PublicKey;
  clock?: () => number;
}): ReadApi {
  const { db } = deps;
  const clock = deps.clock ?? Date.now;

  async function jobViews(jobs: Parameters<typeof jobView>[0][]): Promise<JobView[]> {
    const addresses = jobs.map((job) => job.address);
    const [claims, proofs, validations] = await Promise.all([
      db.claim.findMany({ where: { job: { in: addresses }, closedSlot: null } }),
      db.releaseProof.findMany({ where: { job: { in: addresses } } }),
      db.validationRecord.findMany({ where: { job: { in: addresses } } }),
    ]);
    const byJob = <T extends { job: string }>(rows: T[]) => new Map(rows.map((row) => [row.job, row]));
    const [claimOf, proofOf, validationOf] = [byJob(claims), byJob(proofs), byJob(validations)];
    return jobs.map((job) =>
      jobView(job, {
        claim: claimOf.get(job.address) ?? null,
        releaseProof: proofOf.get(job.address) ?? null,
        validation: validationOf.get(job.address) ?? null,
      }),
    );
  }

  async function agentViews(agents: Parameters<typeof agentView>[0][]): Promise<AgentView[]> {
    const addresses = agents.map((agent) => agent.address);
    const [cards, reputations] = await Promise.all([
      db.agentCard.findMany({ where: { agentRecord: { in: addresses } } }),
      db.agentReputation.findMany({ where: { agentRecord: { in: addresses } } }),
    ]);
    const cardOf = new Map(cards.map((card) => [card.agentRecord, card]));
    const reputationOf = new Map(reputations.map((reputation) => [reputation.agentRecord, reputation]));
    return agents.map((agent) =>
      agentView(agent, {
        did: squareIdentity.formatDidAip({
          chainRef: deps.chainRef,
          registry: deps.registryProgramId,
          agentRecord: new PublicKey(agent.address),
        }),
        card: cardOf.get(agent.address) ?? null,
        reputation: reputationOf.get(agent.address) ?? null,
      }),
    );
  }

  async function policyViews(policies: Parameters<typeof policyView>[0][]): Promise<PolicyView[]> {
    const metas = await db.policyMeta.findMany({ where: { policy: { in: policies.map((p) => p.address) } } });
    const metaOf = new Map(metas.map((meta) => [meta.policy, meta]));
    return policies.map((policy) => policyView(policy, metaOf.get(policy.address) ?? null));
  }

  async function disputeViews(disputes: Parameters<typeof disputeView>[0][]): Promise<DisputeView[]> {
    const jobs = await db.job.findMany({
      where: { address: { in: disputes.map((d) => d.job) } },
      select: { address: true, account: true },
    });
    const accountOf = new Map(jobs.map((job) => [job.address, job.account]));
    return disputes.map((dispute) => disputeView(dispute, accountOf.get(dispute.job) ?? null));
  }

  return {
    async listJobs(filter, page) {
      const f = JobFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const where = {
        closedSlot: null,
        ...(f.status ? { status: f.status } : {}),
        ...(f.institution ? { institution: f.institution } : {}),
        ...(f.agentRecord ? { agentRecord: f.agentRecord } : {}),
        ...(f.policy ? { policy: f.policy } : {}),
      };
      const [rows, total] = await Promise.all([
        db.job.findMany({ where, orderBy: [{ createdAt: 'desc' }, { address: 'asc' }], ...pageWindow(p) }),
        db.job.count({ where }),
      ]);
      return { items: await jobViews(rows), total, ...p };
    },
    async getJob(job) {
      const row = await db.job.findFirst({ where: { address: parseAddress(job), closedSlot: null } });
      return row ? (await jobViews([row]))[0]! : null;
    },
    async getInstitution(institution) {
      const row = await db.institution.findUnique({ where: { address: parseAddress(institution) } });
      return row ? institutionView(row) : null;
    },
    async listPolicies(filter, page) {
      const f = PolicyFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const where = {
        ...(f.institution ? { institution: f.institution } : {}),
        ...(f.active === undefined ? {} : { active: f.active }),
      };
      const [rows, total] = await Promise.all([
        db.policy.findMany({ where, orderBy: [{ slot: 'desc' }, { address: 'asc' }], ...pageWindow(p) }),
        db.policy.count({ where }),
      ]);
      return { items: await policyViews(rows), total, ...p };
    },
    async getPolicy(policy) {
      const row = await db.policy.findUnique({ where: { address: parseAddress(policy) } });
      return row ? (await policyViews([row]))[0]! : null;
    },
    async listAgents(filter, page) {
      const f = AgentFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const withSkill = f.skill
        ? (await db.agentCard.findMany({ where: { skills: { has: f.skill } }, select: { agentRecord: true } })).map(
            (card) => card.agentRecord,
          )
        : null;
      const where = {
        ...(f.owner ? { owner: f.owner } : {}),
        ...(f.status ? { status: f.status } : {}),
        ...(withSkill ? { address: { in: withSkill } } : {}),
      };
      const [rows, total] = await Promise.all([
        db.agent.findMany({ where, orderBy: [{ slot: 'desc' }, { address: 'asc' }], ...pageWindow(p) }),
        db.agent.count({ where }),
      ]);
      return { items: await agentViews(rows), total, ...p };
    },
    async getAgent(agentRecord) {
      const row = await db.agent.findUnique({ where: { address: parseAddress(agentRecord) } });
      return row ? (await agentViews([row]))[0]! : null;
    },
    async listClaims(filter, page) {
      const f = ClaimFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const where = {
        closedSlot: null,
        ...(f.status ? { status: f.status } : {}),
        ...(f.seller ? { seller: f.seller } : {}),
        ...(f.buyer ? { buyer: f.buyer } : {}),
      };
      const [rows, total] = await Promise.all([
        db.claim.findMany({ where, orderBy: [{ slot: 'desc' }, { address: 'asc' }], ...pageWindow(p) }),
        db.claim.count({ where }),
      ]);
      return { items: rows.map(claimView), total, ...p };
    },
    async getClaim(job) {
      const row = await db.claim.findFirst({ where: { job: parseAddress(job), closedSlot: null } });
      return row ? claimView(row) : null;
    },
    async listDisputes(filter, page) {
      const f = DisputeFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const where = f.jobStatus ? { jobStatus: f.jobStatus } : {};
      const [rows, total] = await Promise.all([
        db.dispute.findMany({ where, orderBy: [{ raisedAt: 'desc' }, { job: 'asc' }], ...pageWindow(p) }),
        db.dispute.count({ where }),
      ]);
      return { items: await disputeViews(rows), total, ...p };
    },
    async getDispute(job) {
      const row = await db.dispute.findUnique({ where: { job: parseAddress(job) } });
      return row ? (await disputeViews([row]))[0]! : null;
    },
    async getScreening(wallet) {
      const row = await db.screening.findUnique({ where: { wallet: parseAddress(wallet) } });
      return row ? screeningView(row, unixSeconds(new Date(clock()))) : null;
    },
    async listEvents(filter, page) {
      const f = EventFilterSchema.parse(filter);
      const p = PageSchema.parse(page);
      const where = {
        ...(f.job ? { job: f.job } : {}),
        ...(f.program ? { program: f.program } : {}),
        ...(f.name ? { name: f.name } : {}),
        ...(f.fromSlot === undefined ? {} : { slot: { gte: BigInt(f.fromSlot) } }),
      };
      const [rows, total] = await Promise.all([
        db.chainEvent.findMany({
          where,
          orderBy: [{ slot: 'asc' }, { signature: 'asc' }, { instructionIndex: 'asc' }, { eventIndex: 'asc' }],
          ...pageWindow(p),
        }),
        db.chainEvent.count({ where }),
      ]);
      return { items: rows.map(eventView), total, ...p };
    },
  };
}
