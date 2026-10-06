// REST API istemcisi (`SquareApi`, BE-18). Metotlar OpenAPI operasyonlarıdır; `/v1` yanıtları zarfıyla döner
// (başarısız yanıt da zarftır, `success: false`). Zarfsız uçlar (`/health`, `/ready`, A2A keşif yolu) ve
// gövdesiz 204 yanıtları doğrudan değer ya da `void` döner; bunlarda hata `ApiClientError`'dır. Zarf dışı bir
// yanıt (ör. vekil sunucunun HTML hatası) da `ApiClientError` verir.
import type { AgentCard, ApiEnvelope, ApiError, Health } from '@squaresdk/solana-types';
import type { ApiClientConfig, CreateApiClient, SquareApi } from './api.js';

/** Zarfsız uçların, 204'lerin ve zarf dışı yanıtların hatası. */
export class ApiClientError extends Error {
  constructor(
    /** HTTP durumu. */
    readonly status: number,
    message: string,
    /** Yanıt zarfsa hata nesnesi. */
    readonly error: ApiError | null = null,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/** Sorgu: tanımsız değerler gönderilmez. */
type Query = object;

const isEnvelope = (value: unknown): value is ApiEnvelope<unknown> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { success?: unknown }).success === 'boolean' &&
  'meta' in value;

/** `SquareApi`'nin fetch tabanlı uygulaması. */
export const createApiClient: CreateApiClient = (config: ApiClientConfig): SquareApi => {
  const base = new URL(config.baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('baseUrl http(s) olmalı');
  const send = config.fetch ?? fetch;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    accept: 'application/json',
    ...(config.auth?.session ? { authorization: `Bearer ${config.auth.session}` } : {}),
    ...(config.auth?.apiKey ? { 'x-api-key': config.auth.apiKey } : {}),
    ...extra,
  });

  const url = (path: string, query: Query = {}) => {
    const target = new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base.href : `${base.href}/`);
    for (const [key, value] of Object.entries(query) as [string, unknown][]) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        target.searchParams.set(key, String(value));
      }
    }
    return target;
  };

  async function request(method: string, path: string, init: { query?: Query; json?: unknown; form?: FormData } = {}) {
    const response = await send(url(path, init.query), {
      method,
      headers: headers(init.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.form ? { body: init.form } : {}),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body, text };
  }

  async function envelope<T>(method: string, path: string, init?: Parameters<typeof request>[2]) {
    const { status, body, text } = await request(method, path, init);
    if (!isEnvelope(body)) throw new ApiClientError(status, `zarf olmayan yanıt (${status}): ${text.slice(0, 200)}`);
    return body as ApiEnvelope<T>;
  }

  async function empty(method: string, path: string): Promise<void> {
    const { status, body, text } = await request(method, path);
    if (status === 204) return;
    const error = isEnvelope(body) && !body.success ? body.error : null;
    throw new ApiClientError(status, error?.message ?? `beklenmeyen yanıt (${status}): ${text.slice(0, 200)}`, error);
  }

  async function plain<T>(path: string, accept: (status: number) => boolean): Promise<T> {
    const { status, body, text } = await request('GET', path);
    if (!accept(status) || body === null) {
      const error = isEnvelope(body) && !body.success ? body.error : null;
      throw new ApiClientError(status, error?.message ?? `beklenmeyen yanıt (${status}): ${text.slice(0, 200)}`, error);
    }
    return body as T;
  }

  const segment = (value: string) => encodeURIComponent(value);

  return {
    createAuthChallenge: (body) => envelope('POST', '/v1/auth/challenge', { json: body }),
    createSession: (body) => envelope('POST', '/v1/auth/session', { json: body }),
    deleteSession: () => empty('DELETE', '/v1/auth/session'),
    listApiKeys: () => envelope('GET', '/v1/api-keys'),
    createApiKey: (body) => envelope('POST', '/v1/api-keys', { json: body }),
    deleteApiKey: (id) => empty('DELETE', `/v1/api-keys/${segment(id)}`),

    listJobs: (query = {}) => envelope('GET', '/v1/jobs', { query }),
    getJob: (job) => envelope('GET', `/v1/jobs/${segment(job)}`),
    uploadDelivery: (job, file) => {
      const form = new FormData();
      form.append('file', file);
      return envelope('POST', `/v1/jobs/${segment(job)}/deliveries`, { form });
    },

    getInstitution: (institution) => envelope('GET', `/v1/institutions/${segment(institution)}`),
    listPolicies: (query = {}) => envelope('GET', '/v1/policies', { query }),
    getPolicy: (policy) => envelope('GET', `/v1/policies/${segment(policy)}`),
    putPolicyMeta: (policy, meta) => envelope('PUT', `/v1/policies/${segment(policy)}/meta`, { json: meta }),

    listAgents: (query = {}) => envelope('GET', '/v1/agents', { query }),
    getAgent: (agentRecord) => envelope('GET', `/v1/agents/${segment(agentRecord)}`),
    putAgentCard: (agentRecord, card, options = {}) =>
      envelope('PUT', `/v1/agents/${segment(agentRecord)}/card`, {
        json: card,
        query: { agentId: options.agentId },
      }),
    getWellKnownAgentCard: (agentRecord) =>
      plain<AgentCard>(`/a/${segment(agentRecord)}/.well-known/agent-card.json`, (status) => status === 200),

    listClaims: (query = {}) => envelope('GET', '/v1/claims', { query }),
    getClaim: (job) => envelope('GET', `/v1/claims/${segment(job)}`),
    listDisputes: (query = {}) => envelope('GET', '/v1/disputes', { query }),
    getDispute: (job) => envelope('GET', `/v1/disputes/${segment(job)}`),
    getScreening: (wallet) => envelope('GET', `/v1/screening/${segment(wallet)}`),
    listEvents: (query = {}) => envelope('GET', '/v1/events', { query }),
    listKeeperActions: (query = {}) => envelope('GET', '/v1/keeper/actions', { query }),

    putTravelRule: (job, body) => envelope('PUT', `/v1/jobs/${segment(job)}/travel-rule`, { json: body }),
    getTravelRule: (job) => envelope('GET', `/v1/jobs/${segment(job)}/travel-rule`),
    createTravelRuleGrant: (job, body) =>
      envelope('POST', `/v1/jobs/${segment(job)}/travel-rule/grants`, { json: body }),
    deleteTravelRuleGrant: (job, grantee) =>
      empty('DELETE', `/v1/jobs/${segment(job)}/travel-rule/grants/${segment(grantee)}`),
    listTravelRuleAccess: (job, query = {}) =>
      envelope('GET', `/v1/jobs/${segment(job)}/travel-rule/access`, { query }),

    registerCctpTransfer: (body) => envelope('POST', '/v1/cctp/transfers', { json: body }),
    listCctpTransfers: (query = {}) => envelope('GET', '/v1/cctp/transfers', { query }),
    getCctpTransfer: (id) => envelope('GET', `/v1/cctp/transfers/${segment(id)}`),
    prepareCctpFundTx: (id, body) => envelope('POST', `/v1/cctp/transfers/${segment(id)}/tx`, { json: body }),

    prepareTx: (body) => envelope('POST', '/v1/tx', { json: body }),
    prove: (body) => envelope('POST', '/v1/prove', { json: body }),
    // 503 de sözleşmedeki `Health` gövdesidir.
    getHealth: () => plain<Health>('/health', (status) => status === 200 || status === 503),
    getReady: () => plain<Health>('/ready', (status) => status === 200 || status === 503),
  };
};
