// docs/api/openapi.yaml uçları için MSW handler'ları. Her yol, verilen `SquareApi`'ye (varsayılan:
// mock) bağlanır; böylece web uygulaması gerçek HTTP istemcisiyle (BE-18) mock'a konuşabilir.
// Yol tablosu OpenAPI ile testte karşılaştırılır (test/handlers.test.mjs).
import { HttpResponse, http, type HttpHandler } from 'msw';
import type { SquareApi } from '@squaresdk/solana-sdk';
import type { ApiEnvelope, ApiErrorCode } from '@squaresdk/solana-types';
import { MockApiError } from './api.js';

/** Hata kodu → HTTP durumu (OpenAPI yanıt kodlarıyla uyumlu). */
export const STATUS_BY_ERROR: Record<ApiErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  program_error: 422,
  simulation_failed: 422,
  rpc_unavailable: 503,
  db_unavailable: 503,
  prover_unavailable: 503,
  not_implemented: 501,
  internal_error: 500,
};

type Method = 'get' | 'post' | 'put' | 'delete';
type Params = Record<string, string>;

interface Route {
  operationId: keyof SquareApi;
  method: Method;
  /** OpenAPI biçiminde yol (`{param}`). */
  path: string;
  run(api: SquareApi, request: Request, params: Params): Promise<Response>;
}

const errorEnvelope = (code: ApiErrorCode, message: string): ApiEnvelope<never> => ({
  success: false,
  data: null,
  error: { code, message, programError: null, details: null },
  meta: { requestId: 'mock-http', page: null, limit: null, total: null },
});

const respond = (envelope: ApiEnvelope<unknown>, okStatus = 200): Response =>
  HttpResponse.json(envelope, { status: envelope.success ? okStatus : STATUS_BY_ERROR[envelope.error.code] });

const noContent = (): Response => new HttpResponse(null, { status: 204 });

const body = async (request: Request): Promise<unknown> => request.json().catch(() => undefined);

/** Sorgu dizesinden sayfalama ve filtreler. Geçersiz sayılar NaN olur ve API `invalid_input` döner. */
function query(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const page = (q: Record<string, string>) => ({ page: num(q.page), limit: num(q.limit) });

class BadQuery extends Error {}
function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new BadQuery(`boolean bekleniyor: ${v}`);
}

// Gövde ve sorgu değerleri burada tiplenmez: API (api.ts) her girdiyi zod şemasıyla doğrular.
const ROUTES: Route[] = [
  { operationId: 'createAuthChallenge', method: 'post', path: '/v1/auth/challenge', run: async (api, req) => respond(await api.createAuthChallenge((await body(req)) as never)) },
  { operationId: 'createSession', method: 'post', path: '/v1/auth/session', run: async (api, req) => respond(await api.createSession((await body(req)) as never)) },
  { operationId: 'deleteSession', method: 'delete', path: '/v1/auth/session', run: async (api) => (await api.deleteSession(), noContent()) },
  { operationId: 'listApiKeys', method: 'get', path: '/v1/api-keys', run: async (api) => respond(await api.listApiKeys()) },
  { operationId: 'createApiKey', method: 'post', path: '/v1/api-keys', run: async (api, req) => respond(await api.createApiKey((await body(req)) as never), 201) },
  { operationId: 'deleteApiKey', method: 'delete', path: '/v1/api-keys/{id}', run: async (api, _req, p) => (await api.deleteApiKey(p.id!), noContent()) },

  {
    operationId: 'listJobs',
    method: 'get',
    path: '/v1/jobs',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listJobs({ ...page(q), status: q.status as never, institution: q.institution, agentRecord: q.agentRecord, policy: q.policy }));
    },
  },
  { operationId: 'getJob', method: 'get', path: '/v1/jobs/{job}', run: async (api, _req, p) => respond(await api.getJob(p.job!)) },
  {
    operationId: 'uploadDelivery',
    method: 'post',
    path: '/v1/jobs/{job}/deliveries',
    run: async (api, req, p) => {
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof Blob)) return respond(errorEnvelope('invalid_input', 'multipart `file` alanı gerekli'));
      return respond(await api.uploadDelivery(p.job!, file), 201);
    },
  },

  { operationId: 'getInstitution', method: 'get', path: '/v1/institutions/{institution}', run: async (api, _req, p) => respond(await api.getInstitution(p.institution!)) },
  {
    operationId: 'listPolicies',
    method: 'get',
    path: '/v1/policies',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listPolicies({ ...page(q), institution: q.institution, active: bool(q.active) }));
    },
  },
  { operationId: 'getPolicy', method: 'get', path: '/v1/policies/{policy}', run: async (api, _req, p) => respond(await api.getPolicy(p.policy!)) },
  { operationId: 'putPolicyMeta', method: 'put', path: '/v1/policies/{policy}/meta', run: async (api, req, p) => respond(await api.putPolicyMeta(p.policy!, (await body(req)) as never)) },

  {
    operationId: 'listAgents',
    method: 'get',
    path: '/v1/agents',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listAgents({ ...page(q), owner: q.owner, status: q.status as never, skill: q.skill }));
    },
  },
  { operationId: 'getAgent', method: 'get', path: '/v1/agents/{agentRecord}', run: async (api, _req, p) => respond(await api.getAgent(p.agentRecord!)) },
  { operationId: 'putAgentCard', method: 'put', path: '/v1/agents/{agentRecord}/card', run: async (api, req, p) => respond(await api.putAgentCard(p.agentRecord!, (await body(req)) as never)) },
  {
    operationId: 'getWellKnownAgentCard',
    method: 'get',
    path: '/a/{agentRecord}/.well-known/agent-card.json',
    run: async (api, _req, p) => HttpResponse.json(await api.getWellKnownAgentCard(p.agentRecord!)),
  },

  {
    operationId: 'listClaims',
    method: 'get',
    path: '/v1/claims',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listClaims({ ...page(q), status: q.status as never, seller: q.seller, buyer: q.buyer }));
    },
  },
  { operationId: 'getClaim', method: 'get', path: '/v1/claims/{job}', run: async (api, _req, p) => respond(await api.getClaim(p.job!)) },
  {
    operationId: 'listDisputes',
    method: 'get',
    path: '/v1/disputes',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listDisputes({ ...page(q), jobStatus: q.jobStatus as never }));
    },
  },
  { operationId: 'getDispute', method: 'get', path: '/v1/disputes/{job}', run: async (api, _req, p) => respond(await api.getDispute(p.job!)) },
  { operationId: 'getScreening', method: 'get', path: '/v1/screening/{wallet}', run: async (api, _req, p) => respond(await api.getScreening(p.wallet!)) },
  {
    operationId: 'listEvents',
    method: 'get',
    path: '/v1/events',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listEvents({ ...page(q), job: q.job, program: q.program as never, name: q.name, fromSlot: num(q.fromSlot) }));
    },
  },
  {
    operationId: 'listKeeperActions',
    method: 'get',
    path: '/v1/keeper/actions',
    run: async (api, req) => {
      const q = query(req);
      return respond(await api.listKeeperActions({ ...page(q), job: q.job, outcome: q.outcome as never }));
    },
  },

  { operationId: 'prepareTx', method: 'post', path: '/v1/tx', run: async (api, req) => respond(await api.prepareTx((await body(req)) as never)) },
  { operationId: 'prove', method: 'post', path: '/v1/prove', run: async (api, req) => respond(await api.prove((await body(req)) as never)) },
  {
    operationId: 'getHealth',
    method: 'get',
    path: '/health',
    run: async (api) => {
      const h = await api.getHealth();
      return HttpResponse.json(h, { status: h.status === 'down' ? 503 : 200 });
    },
  },
  {
    operationId: 'getReady',
    method: 'get',
    path: '/ready',
    run: async (api) => {
      const h = await api.getReady();
      return HttpResponse.json(h, { status: h.status === 'down' ? 503 : 200 });
    },
  },
];

/** Handler'ların karşıladığı (operationId, yöntem, OpenAPI yolu) listesi. */
export const MOCK_ROUTES: readonly { operationId: keyof SquareApi; method: Method; path: string }[] = ROUTES.map(({ operationId, method, path }) => ({
  operationId,
  method,
  path,
}));

export interface MockHandlerOptions {
  /** İsteklerin eşleşeceği köken; varsayılan `*` (her köken). Ör. `http://localhost:3000`. */
  baseUrl?: string;
}

export function createMockHandlers(api: SquareApi, options: MockHandlerOptions = {}): HttpHandler[] {
  const base = (options.baseUrl ?? '*').replace(/\/$/, '');
  return ROUTES.map((route) =>
    http[route.method](base + route.path.replace(/\{(\w+)\}/g, ':$1'), async ({ request, params }) => {
      const flat: Params = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : String(v)]));
      try {
        return await route.run(api, request, flat);
      } catch (error) {
        if (error instanceof MockApiError) {
          return HttpResponse.json({ ...errorEnvelope(error.error.code, error.error.message), error: error.error }, { status: STATUS_BY_ERROR[error.error.code] });
        }
        if (error instanceof BadQuery) return respond(errorEnvelope('invalid_input', error.message));
        throw error;
      }
    }),
  );
}
