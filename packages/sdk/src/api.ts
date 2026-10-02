// REST API client imzaları. Metot adları docs/api/openapi.yaml `operationId`'leriyle birebir aynıdır
// (test: packages/sdk/test). Uygulaması BE-18 ile birlikte; FE-24 mock'u bu arayüzü uygular.
import {
  NotImplementedError,
  type Address,
  type AgentCard,
  type AgentCardHosting,
  type AgentStatus,
  type AgentView,
  type ApiEnvelope,
  type ApiKey,
  type ApiKeyCreate,
  type ApiKeyCreated,
  type AuthChallenge,
  type AuthChallengeRequest,
  type ClaimStatus,
  type ClaimView,
  type DeliveryReceipt,
  type DisputeView,
  type Health,
  type IndexedEvent,
  type InstitutionView,
  type JobStatus,
  type JobView,
  type KeeperAction,
  type PolicyMeta,
  type PolicyView,
  type ProveRequest,
  type ProveResponse,
  type ScreeningView,
  type Session,
  type SessionRequest,
  type SquareProgram,
  type TxRequest,
  type UnsignedTx,
} from '@squaresdk/solana-types';

export interface PageParams {
  page?: number;
  limit?: number;
}

export interface SquareApi {
  createAuthChallenge(body: AuthChallengeRequest): Promise<ApiEnvelope<AuthChallenge>>;
  createSession(body: SessionRequest): Promise<ApiEnvelope<Session>>;
  deleteSession(): Promise<void>;
  listApiKeys(): Promise<ApiEnvelope<ApiKey[]>>;
  createApiKey(body: ApiKeyCreate): Promise<ApiEnvelope<ApiKeyCreated>>;
  deleteApiKey(id: string): Promise<void>;

  listJobs(query?: PageParams & { status?: JobStatus; institution?: Address; agentRecord?: Address; policy?: Address }): Promise<ApiEnvelope<JobView[]>>;
  getJob(job: Address): Promise<ApiEnvelope<JobView>>;
  uploadDelivery(job: Address, file: Blob): Promise<ApiEnvelope<DeliveryReceipt>>;

  getInstitution(institution: Address): Promise<ApiEnvelope<InstitutionView>>;
  listPolicies(query?: PageParams & { institution?: Address; active?: boolean }): Promise<ApiEnvelope<PolicyView[]>>;
  getPolicy(policy: Address): Promise<ApiEnvelope<PolicyView>>;
  putPolicyMeta(policy: Address, meta: PolicyMeta): Promise<ApiEnvelope<PolicyView>>;

  listAgents(query?: PageParams & { owner?: Address; status?: AgentStatus; skill?: string }): Promise<ApiEnvelope<AgentView[]>>;
  getAgent(agentRecord: Address): Promise<ApiEnvelope<AgentView>>;
  putAgentCard(agentRecord: Address, card: AgentCard): Promise<ApiEnvelope<AgentCardHosting>>;
  getWellKnownAgentCard(agentRecord: Address): Promise<AgentCard>;

  listClaims(query?: PageParams & { status?: ClaimStatus; seller?: Address; buyer?: Address }): Promise<ApiEnvelope<ClaimView[]>>;
  getClaim(job: Address): Promise<ApiEnvelope<ClaimView>>;
  listDisputes(query?: PageParams & { jobStatus?: JobStatus }): Promise<ApiEnvelope<DisputeView[]>>;
  getDispute(job: Address): Promise<ApiEnvelope<DisputeView>>;
  getScreening(wallet: Address): Promise<ApiEnvelope<ScreeningView>>;
  listEvents(query?: PageParams & { job?: Address; program?: SquareProgram; name?: string; fromSlot?: number }): Promise<ApiEnvelope<IndexedEvent[]>>;
  listKeeperActions(query?: PageParams & { job?: Address; outcome?: KeeperAction['outcome'] }): Promise<ApiEnvelope<KeeperAction[]>>;

  prepareTx(body: TxRequest): Promise<ApiEnvelope<UnsignedTx>>;
  prove(body: ProveRequest): Promise<ApiEnvelope<ProveResponse>>;
  getHealth(): Promise<Health>;
  getReady(): Promise<Health>;
}

/** OpenAPI `operationId` listesi; `SquareApi` ile tip düzeyinde, OpenAPI ile testte eşlenir. */
export const API_OPERATIONS = [
  'createAuthChallenge',
  'createSession',
  'deleteSession',
  'listApiKeys',
  'createApiKey',
  'deleteApiKey',
  'listJobs',
  'getJob',
  'uploadDelivery',
  'getInstitution',
  'listPolicies',
  'getPolicy',
  'putPolicyMeta',
  'listAgents',
  'getAgent',
  'putAgentCard',
  'getWellKnownAgentCard',
  'listClaims',
  'getClaim',
  'listDisputes',
  'getDispute',
  'getScreening',
  'listEvents',
  'listKeeperActions',
  'prepareTx',
  'prove',
  'getHealth',
  'getReady',
] as const satisfies readonly (keyof SquareApi)[];

// SquareApi'de olup listede olmayan metot derleme hatası verir.
type MissingOperations = Exclude<keyof SquareApi, (typeof API_OPERATIONS)[number]>;
const _allOperationsListed: [MissingOperations] extends [never] ? true : MissingOperations = true;
void _allOperationsListed;

export interface ApiClientConfig {
  baseUrl: string;
  /** Oturum belirteci (`createSession`) ya da API anahtarı. */
  auth?: { session?: string; apiKey?: string };
  fetch?: typeof fetch;
}

export function createApiClient(config: ApiClientConfig): SquareApi {
  throw new NotImplementedError('createApiClient', 'BE-18');
}
