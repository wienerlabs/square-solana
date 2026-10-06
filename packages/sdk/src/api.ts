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
  CctpFundTx,
  CctpFundTxRequest,
  CctpTransfer,
  CctpTransferCreate,
  CctpTransferStatus,
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
} from '@squaresdk/solana-types';

/** Sayfalama: `page` 1'den, `limit` 1–200. */
export interface PageParams {
  /** Sayfa numarası (1'den). */
  page?: number;
  /** Sayfa başına kayıt (1–200). */
  limit?: number;
}

/** Square HTTP API'sinin istemcisi; metotlar OpenAPI `operationId`'leridir. */
export interface SquareApi {
  /** `POST /v1/auth/challenge`: cüzdanın imzalayacağı oturum mesajı. */
  createAuthChallenge(body: AuthChallengeRequest): Promise<ApiEnvelope<AuthChallenge>>;
  /** `POST /v1/auth/session`: imzalı mesajla oturum belirteci. */
  createSession(body: SessionRequest): Promise<ApiEnvelope<Session>>;
  /** `DELETE /v1/auth/session`: oturumu kapatır. */
  deleteSession(): Promise<void>;
  /** `GET /v1/api-keys`: oturumun cüzdanının API anahtarları. */
  listApiKeys(): Promise<ApiEnvelope<ApiKey[]>>;
  /** `POST /v1/api-keys`: kapsamlı API anahtarı; gizli değer yalnızca bu yanıtta döner. */
  createApiKey(body: ApiKeyCreate): Promise<ApiEnvelope<ApiKeyCreated>>;
  /** `DELETE /v1/api-keys/{id}`: anahtarı iptal eder. */
  deleteApiKey(id: string): Promise<void>;

  /** `GET /v1/jobs`: job'lar (indexer), durum, kurum, agent kaydı ya da politikaya göre. */
  listJobs(
    query?: PageParams & { status?: JobStatus; institution?: Address; agentRecord?: Address; policy?: Address },
  ): Promise<ApiEnvelope<JobView[]>>;
  /** `GET /v1/jobs/{job}`: tek job; payee, alacak, release ispatı ve doğrulama kaydıyla. */
  getJob(job: Address): Promise<ApiEnvelope<JobView>>;
  /** `POST /v1/jobs/{job}/deliveries`: teslim dosyası; `submit_work`'ün `workHash` ve `deliveryUri`'si döner. */
  uploadDelivery(job: Address, file: Blob): Promise<ApiEnvelope<DeliveryReceipt>>;

  /** `GET /v1/institutions/{institution}`: kurum hesabı. */
  getInstitution(institution: Address): Promise<ApiEnvelope<InstitutionView>>;
  /** `GET /v1/policies`: politikalar, kuruma ve etkinliğe göre. */
  listPolicies(query?: PageParams & { institution?: Address; active?: boolean }): Promise<ApiEnvelope<PolicyView[]>>;
  /** `GET /v1/policies/{policy}`: tek politika ve herkese açık meta verisi. */
  getPolicy(policy: Address): Promise<ApiEnvelope<PolicyView>>;
  /** `PUT /v1/policies/{policy}/meta`: politikanın adı, açıklaması ve etiketleri (kurumun yetkilisi). */
  putPolicyMeta(policy: Address, meta: PolicyMeta): Promise<ApiEnvelope<PolicyView>>;

  /** `GET /v1/agents`: agent kayıtları, sahibe, duruma ve beceriye göre. */
  listAgents(
    query?: PageParams & { owner?: Address; status?: AgentStatus; skill?: string },
  ): Promise<ApiEnvelope<AgentView[]>>;
  /** `GET /v1/agents/{agentRecord}`: tek agent kaydı, itibarı ve kartıyla. */
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
  /** `GET /a/{agentRecord}/.well-known/agent-card.json`: barındırılan agent card'ın kendisi (zarfsız). */
  getWellKnownAgentCard(agentRecord: Address): Promise<AgentCard>;

  /** `GET /v1/claims`: alacak listelemeleri, duruma, satıcıya ve alıcıya göre. */
  listClaims(
    query?: PageParams & { status?: ClaimStatus; seller?: Address; buyer?: Address },
  ): Promise<ApiEnvelope<ClaimView[]>>;
  /** `GET /v1/claims/{job}`: job'un alacak listelemesi. */
  getClaim(job: Address): Promise<ApiEnvelope<ClaimView>>;
  /** `GET /v1/disputes`: dispute'lu job'lar. */
  listDisputes(query?: PageParams & { jobStatus?: JobStatus }): Promise<ApiEnvelope<DisputeView[]>>;
  /** `GET /v1/disputes/{job}`: job'un dispute'u. */
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
  /** `GET /v1/screening/{wallet}`: cüzdanın screening kaydı. */
  getScreening(wallet: Address): Promise<ApiEnvelope<ScreeningView>>;
  /** `GET /v1/events`: indexlenmiş event'ler, job, program, ad ve slot'a göre. */
  listEvents(
    query?: PageParams & { job?: Address; program?: SquareProgram; name?: string; fromSlot?: number },
  ): Promise<ApiEnvelope<IndexedEvent[]>>;
  /** `GET /v1/keeper/actions`: keeper günlüğü (finalize kararları). */
  listKeeperActions(
    query?: PageParams & { job?: Address; outcome?: KeeperAction['outcome'] },
  ): Promise<ApiEnvelope<KeeperAction[]>>;

  /** Travel Rule kaydını şifreli saklar; `commitTravelRule`'un commitment'ı döner (kurumun yetkilisi, oturum). */
  putTravelRule(job: Address, body: TravelRulePut): Promise<ApiEnvelope<TravelRuleStatus>>;
  /** Kaydı ve salt'ı döner (kurumun yetkilisi ya da izinli cüzdan); okuma erişim kaydına yazılır. */
  getTravelRule(job: Address): Promise<ApiEnvelope<TravelRuleDisclosure>>;
  /** `POST /v1/jobs/{job}/travel-rule/grants`: bir cüzdana kaydı okuma izni (kurumun yetkilisi, oturum). */
  createTravelRuleGrant(job: Address, body: TravelRuleGrantCreate): Promise<ApiEnvelope<TravelRuleGrant>>;
  /** `DELETE /v1/jobs/{job}/travel-rule/grants/{grantee}`: okuma iznini geri alır. */
  deleteTravelRuleGrant(job: Address, grantee: Address): Promise<void>;
  /** `GET /v1/jobs/{job}/travel-rule/access`: kaydın erişim günlüğü. */
  listTravelRuleAccess(job: Address, query?: PageParams): Promise<ApiEnvelope<TravelRuleAccess[]>>;

  /** Burn tx'ini job'a bağlar (job'un kurumu); aynı burn yeniden kaydedilirse aynı transfer döner (BE-26). */
  registerCctpTransfer(body: CctpTransferCreate): Promise<ApiEnvelope<CctpTransfer>>;
  /** `GET /v1/cctp/transfers`: CCTP transferleri, job, kurum ve duruma göre. */
  listCctpTransfers(
    query?: PageParams & { job?: Address; institution?: Address; status?: CctpTransferStatus },
  ): Promise<ApiEnvelope<CctpTransfer[]>>;
  /** `GET /v1/cctp/transfers/{transfer}`: tek CCTP transferi. */
  getCctpTransfer(id: string): Promise<ApiEnvelope<CctpTransfer>>;
  /** Kurumun imzalayacağı tx: mesaj teslim edilmediyse mint ile fonlama tek tx'te, edildiyse yalnızca fonlama. */
  prepareCctpFundTx(id: string, body: CctpFundTxRequest): Promise<ApiEnvelope<CctpFundTx>>;

  /** `POST /v1/tx`: IDL'den bir instruction için imzasız, simüle edilmiş v0 tx. */
  prepareTx(body: TxRequest): Promise<ApiEnvelope<UnsignedTx>>;
  /** `POST /v1/prove`: release devresi için Groth16 ispatı (prover vekili; `prove` kapsamlı anahtar). */
  prove(body: ProveRequest): Promise<ApiEnvelope<ProveResponse>>;
  /** `GET /health`: sürecin sağlığı. */
  getHealth(): Promise<Health>;
  /** `GET /ready`: bağımlılıkların (veritabanı, RPC, depo) hazırlığı. */
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

/** `createApiClient` yapılandırması. */
export interface ApiClientConfig {
  /** API'nin kök adresi (sonda `/` olmadan da olur). */
  baseUrl: string;
  /** Oturum belirteci (`createSession`) ya da API anahtarı. */
  auth?: { session?: string; apiKey?: string };
  /** İstekleri gönderen fetch; verilmezse global `fetch`. */
  fetch?: typeof fetch;
}

/** `SquareApi` fabrikası (`createApiClient`). */
export type CreateApiClient = (config: ApiClientConfig) => SquareApi;
