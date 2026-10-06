// Okuma uçları: indexer'ın tabloları (`@squaresdk/solana-indexer/read`) ve keeper günlüğü. Herkese açıktır;
// anahtarla gelen istek `read` kapsamı ister. Sorgu ve yol parametreleri sözleşmenin şemalarıyla doğrulanır.
import type { PrismaClient } from '@squaresdk/solana-db';
import type { ReadApi } from '@squaresdk/solana-indexer/read';
import {
  Address,
  AgentStatusSchema,
  ClaimStatusSchema,
  JobStatusSchema,
  KeeperOutcomeSchema,
  PageQuerySchema,
} from '@squaresdk/solana-types';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireReadScope } from '../auth/middleware.js';
import { notFound, parse, route, sendOk, sendPage } from '../http.js';
import { listKeeperActions } from '../keeper.js';

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const slotQuery = z.coerce.number().int().min(0);

const query = <T extends z.ZodRawShape>(shape: T) => PageQuerySchema.extend(shape).strict();
const JobQuery = query({
  status: JobStatusSchema.optional(),
  institution: Address.optional(),
  agentRecord: Address.optional(),
  policy: Address.optional(),
});
const PolicyQuery = query({ institution: Address.optional(), active: booleanQuery.optional() });
const AgentQuery = query({
  owner: Address.optional(),
  status: AgentStatusSchema.optional(),
  skill: z.string().min(1).max(64).optional(),
});
const ClaimQuery = query({
  status: ClaimStatusSchema.optional(),
  seller: Address.optional(),
  buyer: Address.optional(),
});
const DisputeQuery = query({ jobStatus: JobStatusSchema.optional() });
const EventQuery = query({
  job: Address.optional(),
  program: z.enum(['registry', 'policy', 'verifier', 'escrow']).optional(),
  name: z.string().min(1).max(64).optional(),
  fromSlot: slotQuery.optional(),
});
const KeeperQuery = query({ job: Address.optional(), outcome: KeeperOutcomeSchema.optional() });

/** Sayfa ve filtre ayrımı. */
function split<T extends { page: number; limit: number }>(value: T) {
  const { page, limit, ...filter } = value;
  return { page: { page, limit }, filter };
}

const pathAddress = (req: Request, name: string) => parse(Address, req.params[name], name);

export function readRoutes(deps: { db: PrismaClient; read: ReadApi; readLimit: RequestHandler }): Router {
  const { db, read, readLimit } = deps;
  const router = Router();

  const one = <T>(path: string, param: string, get: (address: string) => Promise<T | null>, what: string) =>
    router.get(
      path,
      readLimit,
      requireReadScope,
      route(async (req, res) => {
        const view = await get(pathAddress(req, param));
        if (view === null) throw notFound(`${what} bulunamadı`);
        sendOk(res, view);
      }),
    );

  const list = <S extends z.ZodType<{ page: number; limit: number }>>(
    path: string,
    schema: S,
    get: (
      filter: Omit<z.infer<S>, 'page' | 'limit'>,
      page: { page: number; limit: number },
    ) => Promise<{
      items: unknown[];
      total: number;
      page: number;
      limit: number;
    }>,
  ) =>
    router.get(
      path,
      readLimit,
      requireReadScope,
      route(async (req, res) => {
        const { page, filter } = split(parse(schema, req.query, 'sorgu'));
        sendPage(res, await get(filter as Omit<z.infer<S>, 'page' | 'limit'>, page));
      }),
    );

  list('/v1/jobs', JobQuery, (filter, page) => read.listJobs(filter, page));
  one('/v1/jobs/:job', 'job', (job) => read.getJob(job), 'job');
  one('/v1/institutions/:institution', 'institution', (address) => read.getInstitution(address), 'kurum');
  list('/v1/policies', PolicyQuery, (filter, page) => read.listPolicies(filter, page));
  one('/v1/policies/:policy', 'policy', (policy) => read.getPolicy(policy), 'policy');
  list('/v1/agents', AgentQuery, (filter, page) => read.listAgents(filter, page));
  one('/v1/agents/:agentRecord', 'agentRecord', (agent) => read.getAgent(agent), 'agent');
  list('/v1/claims', ClaimQuery, (filter, page) => read.listClaims(filter, page));
  one('/v1/claims/:job', 'job', (job) => read.getClaim(job), 'alacak listelemesi');
  list('/v1/disputes', DisputeQuery, (filter, page) => read.listDisputes(filter, page));
  one('/v1/disputes/:job', 'job', (job) => read.getDispute(job), 'dispute');
  one('/v1/screening/:wallet', 'wallet', (wallet) => read.getScreening(wallet), 'screening kaydı');
  list('/v1/events', EventQuery, (filter, page) => read.listEvents(filter, page));
  list('/v1/keeper/actions', KeeperQuery, (filter, page) => listKeeperActions(db, filter, page));
  return router;
}
