// Okuma araçları (cüzdan gerekmez): iş bulma, job okuma, settlement istatistikleri, itibar, agent keşfi. Hepsi
// zincirden okur. Açıklamalar modele Square'in akışını anlatır: kurum job'u bir agent kaydına bağlayarak açar ve
// USDC'yi kasaya kilitler (`Funded`), agent kabul eder ve teslim eder, challenge penceresi bitince keeper ödemeyi
// yapar; politikalı işte ödeme kurumun Groth16 ispatına bağlıdır.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicKey } from '@solana/web3.js';
import { squareIdentity } from '@squaresdk/solana-identity';
import { z } from 'zod';
import { ESCROWED, JOB_STATUSES, type ChainReader, type JobStatusName } from '../chain.js';
import type { SquareMcpConfig } from '../config.js';
import { guarded } from '../result.js';
import { explorerUrl, fromBaseUnits, toBaseUnits } from '../units.js';

const Address = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'base58 Solana adresi')
  .describe('Base58 Solana adresi.');
const Amount = z.string().regex(/^\d+(\.\d+)?$/, 'ondalık sayı');
/** `skill` süzgecinde indirilen en fazla agent card (keşif başına iş sınırı). */
export const MAX_CARD_LOOKUPS = 100;
const CARD_CONCURRENCY = 4;

const isoOf = (seconds: unknown) => {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
};

export function registerReadTools(server: McpServer, deps: { reader: ChainReader; config: SquareMcpConfig }): void {
  const { reader, config } = deps;

  async function jobView(address: PublicKey, account: Record<string, unknown>) {
    const { decimals } = await reader.settlement();
    const json = reader.json('escrow', 'job', account) as Record<string, unknown>;
    return {
      address: address.toBase58(),
      ...json,
      amountUi: fromBaseUnits(BigInt(json['amount'] as string), decimals),
      createdAtIso: isoOf(json['createdAt']),
      deadlineIso: isoOf(json['deadline']),
      challengeEndIso: isoOf(json['challengeEnd']),
      explorer: explorerUrl(config.cluster, `address/${address.toBase58()}`),
    };
  }

  server.registerTool(
    'square_find_work',
    {
      title: 'Find work',
      description: [
        'Find Square jobs on the current Solana network. An institution opens a job bound to one agent record and',
        'locks USDC in the job escrow (status "funded"); that agent then accepts and delivers. Pass agentRecord to',
        'see the jobs waiting for your agent. Amounts are in the settlement token (USDC), e.g. "12.5".',
      ].join(' '),
      inputSchema: {
        agentRecord: Address.optional().describe('Only jobs bound to this agent record.'),
        institution: Address.optional().describe('Only jobs opened by this institution key.'),
        status: z.enum(JOB_STATUSES).optional().describe('Job status; default "funded" (waiting to be accepted).'),
        minAmount: Amount.optional().describe('Minimum escrowed amount in USDC.'),
        maxAmount: Amount.optional().describe('Maximum escrowed amount in USDC.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum jobs to return (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async (args) => {
      const { decimals } = await reader.settlement();
      const status: JobStatusName = args.status ?? 'funded';
      const min = args.minAmount === undefined ? null : toBaseUnits(args.minAmount, decimals);
      const max = args.maxAmount === undefined ? null : toBaseUnits(args.maxAmount, decimals);
      const rows = await reader.jobs({
        status,
        ...(args.agentRecord && { agentRecord: new PublicKey(args.agentRecord) }),
        ...(args.institution && { institution: new PublicKey(args.institution) }),
      });
      const matching = rows
        .map((row) => ({ row, amount: BigInt(String(row.account['amount'])) }))
        .filter(({ amount }) => (min === null || amount >= min) && (max === null || amount <= max))
        .sort((a, b) => Number(b.row.account['createdAt']) - Number(a.row.account['createdAt']));
      const limit = args.limit ?? 20;
      return {
        network: config.cluster,
        status,
        total: matching.length,
        jobs: await Promise.all(matching.slice(0, limit).map(({ row }) => jobView(row.address, row.account))),
        next:
          status === 'funded'
            ? 'The bound agent accepts with square_accept_job, then delivers with square_submit_work.'
            : null,
      };
    }),
  );

  server.registerTool(
    'square_get_job',
    {
      title: 'Get job',
      description: [
        'Read one Square job from the chain: status, escrowed amount, institution, agent record and wallet, policy,',
        'deadline, challenge window end, delivery (work hash and URI) and dispute, plus its receivable listing if',
        'the agent sold the claim. After delivery the keeper releases the escrow when the challenge window ends.',
      ].join(' '),
      inputSchema: { job: Address.describe('Job account address.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ job }) => {
      const address = new PublicKey(job);
      const account = await reader.job(address);
      if (!account) throw new Error(`job bulunamadı: ${job}`);
      const claim = await reader.claim(address);
      return {
        network: config.cluster,
        job: await jobView(address, account),
        claim: claim && reader.json('escrow', 'claimListing', claim),
      };
    }),
  );

  server.registerTool(
    'square_settlement_stats',
    {
      title: 'Settlement stats',
      description: [
        'Protocol-wide settlement figures on the current network, read from every job account: job counts by status,',
        'USDC currently locked in escrow (funded through resolved), USDC released to agents, refunded and cancelled.',
      ].join(' '),
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async () => {
      const { mint, decimals } = await reader.settlement();
      const jobs = await reader.jobSummaries();
      const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0])) as Record<JobStatusName, number>;
      let escrowed = 0n;
      let released = 0n;
      let otherMint = 0;
      for (const job of jobs) {
        counts[job.status] += 1;
        if (!job.mint.equals(mint)) {
          otherMint += 1;
          continue;
        }
        if (ESCROWED.includes(job.status)) escrowed += job.amount;
        if (job.status === 'released') released += job.amount;
      }
      return {
        network: config.cluster,
        settlementMint: mint.toBase58(),
        jobs: jobs.length,
        byStatus: counts,
        escrowedUsdc: fromBaseUnits(escrowed, decimals),
        releasedUsdc: fromBaseUnits(released, decimals),
        jobsInOtherMints: otherMint,
      };
    }),
  );

  server.registerTool(
    'square_get_reputation',
    {
      title: 'Agent reputation',
      description: [
        "An agent's on-chain track record on Square (escrow AgentReputation): jobs completed, failed and disputed,",
        'total earned, first and last settlement. Give the agent record, or an owner wallet to see all its agents.',
      ].join(' '),
      inputSchema: {
        agentRecord: Address.optional().describe('Agent record address.'),
        owner: Address.optional().describe('Owner wallet; every agent record it owns.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ agentRecord, owner }) => {
      if (!agentRecord === !owner) throw new Error('agentRecord ya da owner verilmeli (ikisi birden değil)');
      const records = agentRecord
        ? await (async () => {
            const address = new PublicKey(agentRecord);
            const account = await reader.agent(address);
            if (!account) throw new Error(`agent kaydı bulunamadı: ${agentRecord}`);
            return [{ address, account }];
          })()
        : await reader.agents({ owner: new PublicKey(owner!) });
      const { decimals } = await reader.settlement();
      const reputations = await reader.reputations(records.map((record) => record.address));
      return {
        network: config.cluster,
        agents: records.map((record, index) => {
          const agent = reader.json('registry', 'agentRecord', record.account) as Record<string, unknown>;
          const reputation = reputations[index];
          const json = reputation && (reader.json('escrow', 'agentReputation', reputation) as Record<string, unknown>);
          return {
            agentRecord: record.address.toBase58(),
            agentId: agent['agentId'],
            owner: agent['owner'],
            wallet: agent['wallet'],
            status: agent['status'],
            reputation: json && {
              ...json,
              totalEarnedUsdc: fromBaseUnits(BigInt(json['totalEarned'] as string), decimals),
              firstJobAtIso: isoOf(json['firstJobAt']),
              lastJobAtIso: isoOf(json['lastJobAt']),
            },
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
        'Discover agents registered on Square (did:aip registry), ranked by completed jobs and total earned.',
        'With skill, only agents whose agent card (fetched from agentCardUri and checked against the on-chain',
        'agent_card_hash) lists a skill whose id, name or tags match. An institution hires an agent by opening a',
        'job bound to its agent record (square_create_job).',
      ].join(' '),
      inputSchema: {
        skill: z.string().min(1).max(64).optional().describe('Skill id, name or tag to match (case-insensitive).'),
        status: z.enum(['active', 'inactive', 'deregistered']).optional().describe('Agent status; default active.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum agents to return (default 20).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guarded(async ({ skill, status, limit }) => {
      const records = await reader.agents({ status: status ?? 'active' });
      const reputations = await reader.reputations(records.map((record) => record.address));
      const ranked = records
        .map((record, index) => {
          const reputation = reputations[index];
          return {
            record,
            completed: reputation ? BigInt(String(reputation['jobsCompleted'])) : 0n,
            earned: reputation ? BigInt(String(reputation['totalEarned'])) : 0n,
          };
        })
        .sort((a, b) =>
          a.completed !== b.completed ? (b.completed > a.completed ? 1 : -1) : b.earned > a.earned ? 1 : -1,
        );
      const wanted = limit ?? 20;
      const needle = skill?.toLowerCase();
      const found: Record<string, unknown>[] = [];
      let lookups = 0;
      let unusable = 0;
      for (let start = 0; start < ranked.length && found.length < wanted; start += CARD_CONCURRENCY) {
        const batch = ranked.slice(start, start + CARD_CONCURRENCY);
        const views = await Promise.all(
          batch.map(async ({ record, completed, earned }) => {
            const agent = reader.json('registry', 'agentRecord', record.account) as Record<string, unknown>;
            const base = {
              agentRecord: record.address.toBase58(),
              agentId: agent['agentId'],
              wallet: agent['wallet'],
              agentCardUri: agent['agentCardUri'],
              jobsCompleted: completed.toString(),
              totalEarned: earned.toString(),
            };
            if (!needle) return base;
            if (lookups >= MAX_CARD_LOOKUPS || !agent['agentCardUri']) return null;
            lookups += 1;
            const skills = await cardSkills(String(agent['agentCardUri']), String(agent['agentCardHash']));
            if (skills === null) unusable += 1;
            const matched = skills?.filter((entry) =>
              [entry.id, entry.name, ...entry.tags].some((value) => value.toLowerCase().includes(needle)),
            );
            return matched && matched.length > 0 ? { ...base, skills: matched } : null;
          }),
        );
        found.push(...views.filter((view): view is NonNullable<typeof view> => view !== null));
      }
      return {
        network: config.cluster,
        agents: found.slice(0, wanted),
        scanned: ranked.length,
        // İndirilemeyen, hash'i tutmayan ya da şemaya uymayan kartların agent'ı eşleşmez; sayısı bildirilir.
        ...(needle && { cardsChecked: lookups, cardsUnusable: unusable, cardLimit: MAX_CARD_LOOKUPS }),
      };
    }),
  );

  /** Kartın becerileri; indirilemeyen, hash'i tutmayan ya da şemaya uymayan kart null. */
  async function cardSkills(uri: string, hashHex: string) {
    try {
      const { card, bytes } = await squareIdentity.fetchAgentCard(uri, {
        maxBytes: config.cardMaxBytes,
        timeoutMs: config.timeoutMs,
      });
      return squareIdentity.verifyAgentCardHash(bytes, Buffer.from(hashHex, 'hex')) ? card.skills : null;
    } catch {
      return null;
    }
  }
}
