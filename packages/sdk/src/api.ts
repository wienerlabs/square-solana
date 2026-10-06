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
  ArbitrationQueueItem,
  ArbitrationWebhook,
  ArbitrationWebhookCreate,
  ArbitrationWebhookCreated,
  ApiKey,
  ApiKeyCreate,
  ApiKeyCreated,
  AuthChallenge,
  AuthChallengeRequest,
  ClaimStatus,
  ClaimView,
  DeliveryReceipt,
  DisputeEvidence,
  DisputeView,
  DisputeVoteRequest,
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
  TravelRuleAccess,
  TravelRuleDisclosure,
  TravelRuleGrant,
  TravelRuleGrantCreate,
  TravelRulePut,
  TravelRuleStatus,
  TxRequest,
  UnsignedTx,
  X402Endpoint,
  X402EndpointCreate,
  X402EndpointUpdate,
  X402EndpointUsage,
  X402Payment,
  X402PaymentReport,
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

  listX402Endpoints(): Promise<ApiEnvelope<X402Endpoint[]>>;
  createX402Endpoint(body: X402EndpointCreate): Promise<ApiEnvelope<X402Endpoint>>;
  getX402Endpoint(id: string): Promise<ApiEnvelope<X402Endpoint>>;
  updateX402Endpoint(id: string, body: X402EndpointUpdate): Promise<ApiEnvelope<X402Endpoint>>;
  deleteX402Endpoint(id: string): Promise<void>;
  getX402EndpointUsage(id: string): Promise<ApiEnvelope<X402EndpointUsage>>;
  /** Geliştiricinin sunucusunun uzlaştırdığı ödeme; aynı `fingerprint` ikinci kez bildirilirse ilk kayıt döner. */
  recordX402Payment(id: string, body: X402PaymentReport): Promise<ApiEnvelope<X402Payment>>;

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
  /** Dispute kanıtı; dönen `reasonHash` kurumun `raise_dispute` argümanıdır. */
  uploadDisputeEvidence(job: Address, file: Blob): Promise<ApiEnvelope<DisputeEvidence>>;
  listDisputeEvidence(job: Address): Promise<ApiEnvelope<DisputeEvidence[]>>;
  /** Kanıtın baytları (zarfsız); içerik tipi `Blob.type`'tadır. */
  getDisputeEvidenceContent(job: Address, id: string): Promise<Blob>;
  /** Arbitrator oyu için imzasız `resolve_dispute` tx'i (ön denetimli). */
  prepareDisputeVote(job: Address, body: DisputeVoteRequest): Promise<ApiEnvelope<UnsignedTx>>;
  getArbitrationQueue(query?: PageParams): Promise<ApiEnvelope<ArbitrationQueueItem[]>>;
  listArbitrationWebhooks(): Promise<ApiEnvelope<ArbitrationWebhook[]>>;
  createArbitrationWebhook(body: ArbitrationWebhookCreate): Promise<ApiEnvelope<ArbitrationWebhookCreated>>;
  deleteArbitrationWebhook(id: string): Promise<void>;
  getScreening(wallet: Address): Promise<ApiEnvelope<ScreeningView>>;
  listEvents(
    query?: PageParams & { job?: Address; program?: SquareProgram; name?: string; fromSlot?: number },
  ): Promise<ApiEnvelope<IndexedEvent[]>>;
  listKeeperActions(
    query?: PageParams & { job?: Address; outcome?: KeeperAction['outcome'] },
  ): Promise<ApiEnvelope<KeeperAction[]>>;

  /** Travel Rule kaydını şifreli saklar; `commitTravelRule`'un commitment'ı döner (kurumun yetkilisi, oturum). */
  putTravelRule(job: Address, body: TravelRulePut): Promise<ApiEnvelope<TravelRuleStatus>>;
  /** Kaydı ve salt'ı döner (kurumun yetkilisi ya da izinli cüzdan); okuma erişim kaydına yazılır. */
  getTravelRule(job: Address): Promise<ApiEnvelope<TravelRuleDisclosure>>;
  createTravelRuleGrant(job: Address, body: TravelRuleGrantCreate): Promise<ApiEnvelope<TravelRuleGrant>>;
  deleteTravelRuleGrant(job: Address, grantee: Address): Promise<void>;
  listTravelRuleAccess(job: Address, query?: PageParams): Promise<ApiEnvelope<TravelRuleAccess[]>>;

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
  'listX402Endpoints',
  'createX402Endpoint',
  'getX402Endpoint',
  'updateX402Endpoint',
  'deleteX402Endpoint',
  'getX402EndpointUsage',
  'recordX402Payment',
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
  'uploadDisputeEvidence',
  'listDisputeEvidence',
  'getDisputeEvidenceContent',
  'prepareDisputeVote',
  'getArbitrationQueue',
  'listArbitrationWebhooks',
  'createArbitrationWebhook',
  'deleteArbitrationWebhook',
  'getScreening',
  'listEvents',
  'listKeeperActions',
  'putTravelRule',
  'getTravelRule',
  'createTravelRuleGrant',
  'deleteTravelRuleGrant',
  'listTravelRuleAccess',
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
