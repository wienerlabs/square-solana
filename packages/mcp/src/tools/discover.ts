// Okuma tool'ları: cüzdan ve imza gerektirmez. Veri kaynağı Square REST API'sidir (indexer görünümleri,
// docs/api/openapi.yaml). Covenant MCP'nin beş salt okunur tool'unun Square karşılıkları:
// iş bulma, job okuma (zaman çizelgesi, dispute, alacak), settlement istatistikleri, agent itibarı ve
// agent keşfi (beceri, fiyat, kart). Tool açıklamaları agent'a settlement modelini de anlatır: job bir
// AgentRecord'a bağlı açılır, kurum fonlar, agent kabul edip teslim eder, challenge penceresinden sonra
// keeper ödemeyi serbest bırakır (politikalı işte uyum ispatıyla).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  Address,
  AgentStatusSchema,
  JobStatusSchema,
  U64,
  type AgentView,
  type JobStatus,
  type JobView,
  type KeeperAction,
} from '@squaresdk/solana-types';
import { z } from 'zod';
import { unwrap, unwrapOrNull } from '../api.js';
import { ToolInputError, guarded, hash, iso, type ToolContext } from './result.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const Page = z.number().int().min(1).optional().describe('Page number (default 1).');
const Limit = (fallback: number) =>
  z.number().int().min(1).max(200).optional().describe(`Page size, at most 200 (default ${fallback}).`);

/** Job'un agent'a gösterilen özeti; ham hesap `square_get_job`'da. */
export function jobSummary(view: JobView) {
  const job = view.account;
  return {
    address: view.address,
    status: job.status,
    institution: job.institution,
    agentRecord: job.agentRecord,
    agentWallet: job.agentWallet,
    payee: view.payee,
    amount: job.amount,
    mint: job.mint,
    specHash: job.specHash,
    policy: job.policy,
    createdAt: iso(job.createdAt),
    fundedAt: iso(job.fundedAt),
    deadline: iso(job.deadline),
    challengePeriodSeconds: job.challengePeriod,
    challengeEnd: iso(job.challengeEnd),
    deliveredAt: iso(job.deliveredAt),
    settledAt: iso(job.settledAt),
    workHash: hash(job.workHash),
    deliveryUri: job.deliveryUri || null,
    disputed: job.dispute.raisedAt > 0,
    claim: view.claim ? { status: view.claim.status, seller: view.claim.seller, price: view.claim.price } : null,
  };
}

/** Durumdan sonraki adım; agent'ın ne yapabileceğini anlatır. */
export function nextAction(status: JobStatus): string {
  switch (status) {
    case 'open':
      return 'Created but not funded: the institution funds it (square_open_job with the same spec).';
    case 'funded':
      return "Funded and waiting for the bound agent: the agent's wallet accepts it with square_accept_job.";
    case 'accepted':
      return 'Accepted: the agent delivers with square_deliver_work before the deadline.';
    case 'delivered':
      return 'Delivered: the institution may dispute until challengeEnd; afterwards a keeper releases the escrow (with a compliance proof when the job has a policy).';
    case 'disputed':
      return 'Disputed: the arbitrators decide; see the dispute section.';
    case 'resolved':
      return 'Dispute decided: a keeper executes the resolution.';
    case 'released':
      return 'Settled: the escrow was paid to the payee.';
    case 'refunded':
      return 'Settled: the escrow was refunded to the institution.';
    case 'cancelled':
      return 'Cancelled by the institution before funding.';
  }
}

function agentSummary(view: AgentView) {
  const card = view.card;
  const rep = view.reputation;
  return {
    agentRecord: view.address,
    did: view.did,
    status: view.account.status,
    owner: view.account.owner,
    wallet: view.account.wallet,
    name: card?.name ?? null,
    description: card?.description ?? null,
    a2aEndpoint: card?.url ?? null,
    cardVerified: view.cardVerified,
    active: card ? card.active !== false : null,
    skills: card?.skills.map((skill) => ({ id: skill.id, name: skill.name, tags: skill.tags })) ?? [],
    pricing: card?.pricing ?? [],
    x402Support: card?.x402Support ?? false,
    reputation: rep ? reputationSummary(rep) : null,
  };
}

function reputationSummary(rep: NonNullable<AgentView['reputation']>) {
  const completed = BigInt(rep.jobsCompleted);
  const failed = BigInt(rep.jobsFailed);
  const finished = completed + failed;
  return {
    jobsCompleted: rep.jobsCompleted,
    jobsFailed: rep.jobsFailed,
    jobsDisputed: rep.jobsDisputed,
    totalEarned: rep.totalEarned,
    firstJobAt: iso(rep.firstJobAt),
    lastJobAt: iso(rep.lastJobAt),
    successRate: finished === 0n ? null : Number((completed * 10_000n) / finished) / 10_000,
  };
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000);

const JOB_STATUSES = JobStatusSchema.options;
const KEEPER_OUTCOMES: KeeperAction['outcome'][] = ['submitted', 'confirmed', 'skipped', 'failed'];

export function registerReadTools(server: McpServer, ctx: ToolContext): void {
  const { api } = ctx;

  server.registerTool(
    'square_find_work',
    {
      title: 'Find work',
      description: [
        'Find jobs on Square, the compliant agent-to-agent settlement layer on Solana.',
        'An institution creates a job bound to one registered agent (AgentRecord), locks the settlement token',
        'in a per-job escrow (status funded), the agent accepts and delivers, and after the challenge window a',
        'keeper releases the escrow to the payee. Defaults to funded jobs, i.e. work waiting to be accepted;',
        'filter by agentRecord to see the jobs bound to your agent. Amounts are base units of the settlement mint.',
      ].join(' '),
      inputSchema: {
        status: JobStatusSchema.optional().describe('Job status filter (default funded).'),
        agentRecord: Address.optional().describe('Only jobs bound to this AgentRecord.'),
        institution: Address.optional().describe('Only jobs created by this institution.'),
        policy: Address.optional().describe('Only jobs under this policy.'),
        minAmount: U64.optional().describe('Minimum escrow amount (base units); applied to the returned page.'),
        maxAmount: U64.optional().describe('Maximum escrow amount (base units); applied to the returned page.'),
        page: Page,
        limit: Limit(20),
      },
      annotations: { title: 'Find work', ...READ_ONLY },
    },
    guarded(async (args) => {
      const status = args.status ?? 'funded';
      const { data, meta } = await unwrap(
        api.listJobs({
          status,
          ...(args.agentRecord && { agentRecord: args.agentRecord }),
          ...(args.institution && { institution: args.institution }),
          ...(args.policy && { policy: args.policy }),
          page: args.page ?? 1,
          limit: args.limit ?? 20,
        }),
      );
      const min = args.minAmount === undefined ? null : BigInt(args.minAmount);
      const max = args.maxAmount === undefined ? null : BigInt(args.maxAmount);
      const jobs = data
        .filter((view) => {
          const amount = BigInt(view.account.amount);
          return (min === null || amount >= min) && (max === null || amount <= max);
        })
        .map(jobSummary);
      return {
        network: ctx.network,
        status,
        page: meta.page,
        limit: meta.limit,
        total: meta.total,
        returned: jobs.length,
        jobs,
        hint:
          status === 'funded'
            ? 'A funded job can only be accepted by its agentWallet: use square_accept_job with that wallet.'
            : nextAction(status),
      };
    }),
  );

  server.registerTool(
    'square_get_job',
    {
      title: 'Get job',
      description: [
        'Read one Square job by its address (job PDA): lifecycle status, escrow amount, deadline, challenge',
        'window, delivery (workHash, deliveryUri), the dispute if any, the receivable (claim) listing if the',
        'agent sold it, the compliance release proof and validation record, and a timeline of indexed on-chain',
        'events. Also says what the next step in the lifecycle is.',
      ].join(' '),
      inputSchema: {
        job: Address.describe('Job PDA address.'),
        timelineLimit: Limit(100),
      },
      annotations: { title: 'Get job', ...READ_ONLY },
    },
    guarded(async ({ job, timelineLimit }) => {
      const view = await unwrapOrNull(api.getJob(job));
      if (!view) throw new ToolInputError(`job ${job} not found (it may not be indexed yet)`);
      const [events, dispute] = await Promise.all([
        unwrap(api.listEvents({ job, limit: timelineLimit ?? 100 })),
        view.account.dispute.raisedAt > 0 ? unwrapOrNull(api.getDispute(job)) : Promise.resolve(null),
      ]);
      const timeline = [...events.data]
        .sort((a, b) => a.slot - b.slot || a.instructionIndex - b.instructionIndex || a.eventIndex - b.eventIndex)
        .map((event) => ({
          event: event.payload.name,
          program: event.payload.program,
          at: iso(event.blockTime),
          slot: event.slot,
          signature: event.signature,
          data: event.payload.data,
        }));
      return {
        network: ctx.network,
        job: jobSummary(view),
        next: nextAction(view.account.status),
        dispute: dispute
          ? {
              challenger: dispute.dispute.challenger,
              bond: dispute.dispute.bond,
              reasonHash: dispute.dispute.reasonHash,
              raisedAt: iso(dispute.dispute.raisedAt),
              deadline: iso(dispute.dispute.deadline),
              decidedAt: iso(dispute.dispute.decidedAt),
              closedAt: iso(dispute.dispute.closedAt),
              lapsed: dispute.dispute.lapsed,
              approvals: dispute.dispute.approvalCount,
              resolution: dispute.dispute.resolution,
            }
          : null,
        claim: view.claim,
        releaseProof: view.releaseProof,
        validation: view.validation,
        timeline,
        timelineTotal: events.meta.total,
        indexedAt: iso(view.indexedAt),
        slot: view.slot,
        account: view.account,
      };
    }),
  );

  server.registerTool(
    'square_settlement_stats',
    {
      title: 'Settlement stats',
      description: [
        'Protocol-wide settlement metrics on the current network: job counts per lifecycle status, jobs whose',
        'escrow is still locked, dispute count, release and dispute rates, and keeper (finalize crank) outcomes.',
        'With includeVolume it also pages through released and delivered jobs to sum the settled volume, the',
        'average delivery-to-settlement time and the jobs currently inside their challenge window.',
      ].join(' '),
      inputSchema: {
        includeVolume: z.boolean().optional().describe('Also compute volume and timing (pages through jobs).'),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Pages of 200 jobs read per status for volume (default 5).'),
      },
      annotations: { title: 'Settlement stats', ...READ_ONLY },
    },
    guarded(async ({ includeVolume, maxPages }) => {
      const total = async (pending: Promise<{ meta: { total: number | null } }>) => (await pending).meta.total ?? 0;
      const [statusCounts, disputes, keeper] = await Promise.all([
        Promise.all(JOB_STATUSES.map((status) => total(unwrap(api.listJobs({ status, limit: 1 }))))),
        total(unwrap(api.listDisputes({ limit: 1 }))),
        Promise.all(KEEPER_OUTCOMES.map((outcome) => total(unwrap(api.listKeeperActions({ outcome, limit: 1 }))))),
      ]);
      const jobs = Object.fromEntries(JOB_STATUSES.map((status, i) => [status, statusCounts[i] ?? 0])) as Record<
        JobStatus,
        number
      >;
      const all = statusCounts.reduce((sum, count) => sum + (count ?? 0), 0);
      const locked = jobs.funded + jobs.accepted + jobs.delivered + jobs.disputed + jobs.resolved;
      const reachedDelivery = jobs.delivered + jobs.disputed + jobs.resolved + jobs.released + jobs.refunded;

      let volume: Record<string, unknown> | null = null;
      if (includeVolume) {
        const pages = maxPages ?? 5;
        const read = async (status: JobStatus) => {
          const views: JobView[] = [];
          let complete = false;
          for (let page = 1; page <= pages; page++) {
            const { data, meta } = await unwrap(api.listJobs({ status, page, limit: 200 }));
            views.push(...data);
            if (data.length < 200 || views.length >= (meta.total ?? 0)) {
              complete = true;
              break;
            }
          }
          return { views, complete };
        };
        const [released, delivered] = await Promise.all([read('released'), read('delivered')]);
        const now = Math.floor(Date.now() / 1000);
        const settleTimes = released.views
          .filter((view) => view.account.deliveredAt > 0 && view.account.settledAt >= view.account.deliveredAt)
          .map((view) => view.account.settledAt - view.account.deliveredAt);
        volume = {
          releasedAmount: released.views.reduce((sum, view) => sum + BigInt(view.account.amount), 0n),
          releasedJobsCounted: released.views.length,
          averageDeliveryToSettlementSeconds:
            settleTimes.length === 0 ? null : Math.round(settleTimes.reduce((a, b) => a + b, 0) / settleTimes.length),
          inChallengeWindow: delivered.views.filter((view) => view.account.challengeEnd > now).length,
          complete: released.complete && delivered.complete,
        };
      }

      return {
        network: ctx.network,
        jobs: { total: all, byStatus: jobs, escrowLocked: locked },
        disputes,
        rates: {
          releaseRate: ratio(jobs.released, jobs.released + jobs.refunded),
          disputeRate: ratio(disputes, reachedDelivery),
        },
        keeper: Object.fromEntries(KEEPER_OUTCOMES.map((outcome, i) => [outcome, keeper[i] ?? 0])),
        volume,
        definitions: {
          escrowLocked: 'funded + accepted + delivered + disputed + resolved',
          releaseRate: 'released / (released + refunded)',
          disputeRate: 'jobs with a dispute / jobs that reached delivery or a later status',
        },
      };
    }),
  );

  server.registerTool(
    'square_get_reputation',
    {
      title: 'Get reputation',
      description: [
        "Read an agent's on-chain reputation on Square: jobs completed, failed and disputed, total earned and",
        'success rate. Reputation is bound to the registered agent (AgentRecord), not to a wallet; pass the',
        "agentRecord, or an owner wallet to list all of that owner's agents. Also returns the sanctions",
        "screening of the agent's payout wallet (a stale or flagged screening blocks funding).",
      ].join(' '),
      inputSchema: {
        agentRecord: Address.optional().describe('AgentRecord PDA (the last segment of the did:aip identifier).'),
        owner: Address.optional().describe('Owner wallet: lists the reputation of every agent it owns.'),
      },
      annotations: { title: 'Get reputation', ...READ_ONLY },
    },
    guarded(async ({ agentRecord, owner }) => {
      if (!agentRecord === !owner) throw new ToolInputError('pass exactly one of agentRecord or owner');
      let agents: AgentView[];
      if (agentRecord) {
        const view = await unwrapOrNull(api.getAgent(agentRecord));
        if (!view) throw new ToolInputError(`agent ${agentRecord} not found (it may not be indexed yet)`);
        agents = [view];
      } else {
        agents = (await unwrap(api.listAgents({ owner: owner!, limit: 200 }))).data;
      }
      const screenings = await Promise.all(agents.map((view) => unwrapOrNull(api.getScreening(view.account.wallet))));
      return {
        network: ctx.network,
        agents: agents.map((view, i) => {
          const screening = screenings[i];
          return {
            agentRecord: view.address,
            did: view.did,
            name: view.card?.name ?? null,
            status: view.account.status,
            owner: view.account.owner,
            wallet: view.account.wallet,
            cardVerified: view.cardVerified,
            reputation: view.reputation ? reputationSummary(view.reputation) : null,
            screening: screening
              ? {
                  status: screening.account.status,
                  fresh: screening.fresh,
                  expiresAt: iso(screening.account.expiresAt),
                }
              : null,
          };
        }),
      };
    }),
  );

  server.registerTool(
    'square_discover_agents',
    {
      title: 'Discover agents',
      description: [
        'Discover registered agents on Square by capability. Matches the skill id or tag in the agent card,',
        'returns the card (name, description, A2A endpoint, skills, pricing), whether the hosted card matches',
        'the on-chain hash (cardVerified) and the on-chain reputation, ranked by completed jobs. Use it to pick',
        'a counterparty before opening a job bound to its agentRecord.',
      ].join(' '),
      inputSchema: {
        skill: z.string().min(1).max(64).optional().describe('Skill id or tag from the agent card.'),
        status: AgentStatusSchema.optional().describe('Registry status (default active).'),
        owner: Address.optional().describe('Only agents of this owner wallet.'),
        maxPrice: U64.optional().describe('Only agents with a listed price at or below this (base units).'),
        verifiedOnly: z.boolean().optional().describe('Only agents whose hosted card matches the on-chain hash.'),
        page: Page,
        limit: Limit(20),
      },
      annotations: { title: 'Discover agents', ...READ_ONLY },
    },
    guarded(async (args) => {
      const { data, meta } = await unwrap(
        api.listAgents({
          status: args.status ?? 'active',
          ...(args.skill && { skill: args.skill }),
          ...(args.owner && { owner: args.owner }),
          page: args.page ?? 1,
          limit: args.limit ?? 20,
        }),
      );
      const max = args.maxPrice === undefined ? null : BigInt(args.maxPrice);
      const agents = data
        .filter((view) => !args.verifiedOnly || view.cardVerified)
        .filter((view) => {
          if (max === null) return true;
          const prices = (view.card?.pricing ?? []).filter(
            (price) => !args.skill || price.skillId === args.skill || skillHasTag(view, price.skillId, args.skill),
          );
          return prices.some((price) => BigInt(price.amount) <= max);
        })
        .map(agentSummary)
        .sort((a, b) => {
          const completed = (s: typeof a) => BigInt(s.reputation?.jobsCompleted ?? '0');
          const earned = (s: typeof a) => BigInt(s.reputation?.totalEarned ?? '0');
          const byJobs = completed(b) - completed(a);
          if (byJobs !== 0n) return byJobs > 0n ? 1 : -1;
          const byEarned = earned(b) - earned(a);
          return byEarned === 0n ? 0 : byEarned > 0n ? 1 : -1;
        });
      return {
        network: ctx.network,
        page: meta.page,
        limit: meta.limit,
        total: meta.total,
        returned: agents.length,
        agents,
      };
    }),
  );
}

const skillHasTag = (view: AgentView, skillId: string, tag: string) =>
  view.card?.skills.some((skill) => skill.id === skillId && skill.tags.includes(tag)) ?? false;
