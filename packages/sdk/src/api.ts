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
  CctpFundTx,
  CctpFundTxRequest,
  CctpTransfer,
  CctpTransferCreate,
  CctpTransferStatus,
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
  TravelRuleAccess,
  TravelRuleDisclosure,
  TravelRuleGrant,
  TravelRuleGrantCreate,
  TravelRulePut,
  TravelRuleStatus,
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

  /** Travel Rule kaydını şifreli saklar; `commitTravelRule`'un commitment'ı döner (kurumun yetkilisi, oturum). */
  putTravelRule(job: Address, body: TravelRulePut): Promise<ApiEnvelope<TravelRuleStatus>>;
  /** Kaydı ve salt'ı döner (kurumun yetkilisi ya da izinli cüzdan); okuma erişim kaydına yazılır. */
  getTravelRule(job: Address): Promise<ApiEnvelope<TravelRuleDisclosure>>;
  createTravelRuleGrant(job: Address, body: TravelRuleGrantCreate): Promise<ApiEnvelope<TravelRuleGrant>>;
  deleteTravelRuleGrant(job: Address, grantee: Address): Promise<void>;
  listTravelRuleAccess(job: Address, query?: PageParams): Promise<ApiEnvelope<TravelRuleAccess[]>>;

  /** Burn tx'ini job'a bağlar (job'un kurumu); aynı burn yeniden kaydedilirse aynı transfer döner (BE-26). */
  registerCctpTransfer(body: CctpTransferCreate): Promise<ApiEnvelope<CctpTransfer>>;
  listCctpTransfers(
    query?: PageParams & { job?: Address; institution?: Address; status?: CctpTransferStatus },
  ): Promise<ApiEnvelope<CctpTransfer[]>>;
  getCctpTransfer(id: string): Promise<ApiEnvelope<CctpTransfer>>;
  /** Kurumun imzalayacağı tx: mesaj teslim edilmediyse mint ile fonlama tek tx'te, edildiyse yalnızca fonlama. */
  prepareCctpFundTx(id: string, body: CctpFundTxRequest): Promise<ApiEnvelope<CctpFundTx>>;

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
  'putTravelRule',
  'getTravelRule',
  'createTravelRuleGrant',
  'deleteTravelRuleGrant',
  'listTravelRuleAccess',
  'registerCctpTransfer',
  'listCctpTransfers',
  'getCctpTransfer',
  'prepareCctpFundTx',
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
