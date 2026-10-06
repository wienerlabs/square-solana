// REST API client sözleşmesi. Metot adları docs/api/openapi.yaml `operationId`'leriyle birebir aynıdır
// (test: packages/sdk/test). Uygulaması `createApiClient` (api-client.ts, BE-18); web app veri katmanı (FE-24)
// bu arayüzü kullanır.
import type {
  Address,
  AgentCard,
  AgentCardHosting,
  AgentStatus,
  AgentView,
  ApiEnvelope,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  AuthChallenge,
  AuthChallengeRequest,
  ClaimStatus,
  ClaimView,
  DeliveryReceipt,
  DisputeView,
  Health,
  IndexedEvent,
  InstitutionView,
  JobStatus,
  JobView,
  KeeperAction,
  PolicyMeta,
  PolicyView,
  ProveRequest,
  ProveResponse,
  ScreeningView,
  Session,
  SessionRequest,
  SquareProgram,
  TxRequest,
  UnsignedTx,
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

  listJobs(
    query?: PageParams & { status?: JobStatus; institution?: Address; agentRecord?: Address; policy?: Address },
  ): Promise<ApiEnvelope<JobView[]>>;
  getJob(job: Address): Promise<ApiEnvelope<JobView>>;
  uploadDelivery(job: Address, file: Blob): Promise<ApiEnvelope<DeliveryReceipt>>;

  getInstitution(institution: Address): Promise<ApiEnvelope<InstitutionView>>;
  listPolicies(query?: PageParams & { institution?: Address; active?: boolean }): Promise<ApiEnvelope<PolicyView[]>>;
  getPolicy(policy: Address): Promise<ApiEnvelope<PolicyView>>;
  putPolicyMeta(policy: Address, meta: PolicyMeta): Promise<ApiEnvelope<PolicyView>>;

  listAgents(
    query?: PageParams & { owner?: Address; status?: AgentStatus; skill?: string },
  ): Promise<ApiEnvelope<AgentView[]>>;
  getAgent(agentRecord: Address): Promise<ApiEnvelope<AgentView>>;
  /**
   * Kartı barındırır. Kayıt henüz zincirde yoksa `agentId` (`register_agent`'ın `agent_id`'si) verilir: sunucu
   * `agentRecord`'ın çağıranın cüzdanı ve bu kimlikle türetildiğini denetler.
   */
  putAgentCard(
    agentRecord: Address,
    card: AgentCard,
    options?: { agentId?: string },
  ): Promise<ApiEnvelope<AgentCardHosting>>;
  getWellKnownAgentCard(agentRecord: Address): Promise<AgentCard>;

  listClaims(
    query?: PageParams & { status?: ClaimStatus; seller?: Address; buyer?: Address },
  ): Promise<ApiEnvelope<ClaimView[]>>;
  getClaim(job: Address): Promise<ApiEnvelope<ClaimView>>;
  listDisputes(query?: PageParams & { jobStatus?: JobStatus }): Promise<ApiEnvelope<DisputeView[]>>;
  getDispute(job: Address): Promise<ApiEnvelope<DisputeView>>;
  getScreening(wallet: Address): Promise<ApiEnvelope<ScreeningView>>;
  listEvents(
    query?: PageParams & { job?: Address; program?: SquareProgram; name?: string; fromSlot?: number },
  ): Promise<ApiEnvelope<IndexedEvent[]>>;
  listKeeperActions(
    query?: PageParams & { job?: Address; outcome?: KeeperAction['outcome'] },
  ): Promise<ApiEnvelope<KeeperAction[]>>;

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

/** `SquareApi` fabrikası (`createApiClient`). */
export type CreateApiClient = (config: ApiClientConfig) => SquareApi;
