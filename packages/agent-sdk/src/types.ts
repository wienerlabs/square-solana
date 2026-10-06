// Agent yazma kitinin genel tipleri (BE-19). Dağıtıma bağlı her değer (RPC, program kimlikleri, cüzdan,
// public URL, fiyatlar, API adresi) çağırandan gelir; paket varsayılan adres ya da fiyat uydurmaz.
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Commitment, Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { A2aServerLimits, Authenticator, TaskStore } from '@squaresdk/solana-a2a';
import type { SquareApi, SquareProgramIds, WalletLike } from '@squaresdk/solana-sdk';
import type { AgentCard, DeliveryReceipt, Message } from '@squaresdk/solana-types';

/** Tx imzalayan cüzdan: `Keypair` ya da wallet-adapter uyumlu imzacı. */
export type AgentSigner = Keypair | WalletLike;

/** Agent'ın sunduğu iş türü; kartta `skills` ve `pricing` girdisi olur. */
export interface AgentCapability {
  /** Beceri kimliği (kartta `skills[].id`, job spec'inde `capability`). */
  id: string;
  name: string;
  description: string;
  tags: readonly string[];
  examples?: readonly string[];
  /**
   * İşin en düşük fiyatı, settlement mint'in atomik biriminde (ör. 6 ondalıklı USDC'de 1 USDC = 1_000_000).
   * Job'un `amount`'u bunun altındaysa görev reddedilir.
   */
  price: bigint;
}

/** Zincirdeki job'un agent'ı ilgilendiren alanları. */
export interface JobInfo {
  address: PublicKey;
  institution: PublicKey;
  agentRecord: PublicKey;
  agentWallet: PublicKey;
  mint: PublicKey;
  /** Mint'in atomik biriminde. */
  amount: bigint;
  /** Unix saniyesi; teslim bundan önce olmalı. */
  deadline: number;
  /** 64 küçük harf hex. */
  specHash: string;
}

/** İşleyiciye verilen iş. */
export interface JobRequest {
  capability: AgentCapability;
  /** Görevi açan mesajın `data` parçası; RFC 8785 + SHA-256'sı zincirdeki `spec_hash` ile aynı. */
  spec: unknown;
  job: JobInfo;
  taskId: string;
  /** Görevi açan çağıranın kimliği (`Caller.id`). */
  caller: string;
  message: Message;
  /** Görev iptal edilince ya da sunucu kapanınca kesilir. */
  signal: AbortSignal;
  /** Görevin durum metnini günceller (WORKING kalır). */
  progress(text: string): Promise<void>;
}

/** İşleyicinin ürettiği teslimat. Metin `text/plain; charset=utf-8` olarak yüklenir. */
export type Deliverable = string | { content: string | Uint8Array; contentType: string };

export type JobHandler = (request: JobRequest) => Promise<Deliverable>;

/** Teslimatı yükleyip `submit_work` argümanlarını döner (`workHash` içeriğin SHA-256'sı). */
export interface DeliveryUploader {
  upload(input: { job: PublicKey; content: Uint8Array; contentType: string }): Promise<DeliveryReceipt>;
}

export interface AgentLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface TxOptions {
  /** Mikro-lamport cinsinden priority fee; verilmezse eklenmez. */
  computeUnitPrice?: bigint;
  /** Square address lookup table'ı vb. */
  addressLookupTables?: readonly PublicKey[];
}

export interface AgentOptions {
  name: string;
  description: string;
  /** Kartta `version`. */
  version: string;
  provider?: { organization: string; url: string };
  /**
   * Agent'ın dışarıdan erişilen https adresi (yol öneki olabilir). Kart `${publicUrl}/a2a`'yı A2A uç noktası,
   * `${publicUrl}/.well-known/agent-card.json`'u kart adresi olarak ilan eder.
   */
  publicUrl: string;
  /** Registry `agent_id`'si: `[A-Za-z0-9_-]{1,32}`. */
  agentId: string;
  capabilities: readonly AgentCapability[];
  handler: JobHandler;
  /** Job'un agent cüzdanı: `accept_job`, `submit_work`, `list_claim`'i imzalar ve ücretleri öder. */
  signer: AgentSigner;
  /** AgentRecord'un sahibi; verilmezse `signer`. Kaydın adresi `["agent", owner, agentId]` PDA'sıdır. */
  owner?: PublicKey;
  connection: Connection;
  programIds: SquareProgramIds;
  /** Verilmezse bağlantının commitment'ı. */
  commitment?: Commitment;
  /** CAIP-2 Solana referansı (genesis hash'in ilk 32 karakteri); verilmezse bağlantıdan okunur. */
  chainRef?: string;
  /** Square API'si: teslimat yükleme ve kart barındırma. `delivery` verilmezse zorunlu. */
  api?: SquareApi | { baseUrl: string; apiKey?: string; fetch?: typeof fetch };
  /** Teslimat deposu; verilmezse `api`'nin `uploadDelivery`'si. */
  delivery?: DeliveryUploader;
  /** A2A görev deposu (ürün: `@squaresdk/solana-a2a/prisma`). */
  store: TaskStore;
  /** A2A çağıranının kimliği (ör. `createApiKeyAuthenticator`). */
  authenticate: Authenticator;
  /** Teslimden sonra alacağı nominal değerin `discountBps` kadar altında listeler (`list_claim`). */
  autoListClaim?: { discountBps: number };
  /** `autoListClaim` bir alacağı listeleyince çağrılır. */
  onClaimListed?: (listing: ClaimListing) => void;
  limits?: Partial<A2aServerLimits>;
  tx?: TxOptions;
  /** Agent, zincir ve depo hataları; tel üzerinden ayrıntı gönderilmez. */
  onError?: (error: unknown) => void;
  logger?: AgentLogger;
  /** Saat (unix saniyesi); deadline denetimi için. */
  now?: () => number;
}

export interface RegistrationResult {
  status: 'registered' | 'updated' | 'unchanged';
  agentRecord: PublicKey;
  agentCardUri: string;
  /** 64 küçük harf hex. */
  agentCardHash: string;
  /** Gönderilen tx; değişiklik yoksa null. */
  signature: string | null;
}

export interface RegisterOptions {
  /** `self`: kart agent'ın kendi well-known yolunda; `api`: Square API'sinde barındırılır (`putAgentCard`). */
  hosting?: 'self' | 'api';
  /** Kaydın sahibi `signer`'dan farklıysa sahibin imzacısı. */
  owner?: AgentSigner;
}

/** Alacak listeleme sonucu; `autoListClaim` açıksa her teslimde bildirilir. */
export interface ClaimListing {
  job: PublicKey;
  price: bigint;
  signature: string;
}

export interface Agent {
  readonly card: AgentCard;
  /** Kartın RFC 8785 kanonik JSON baytları; well-known yolu bunları sunar. */
  readonly cardBytes: Uint8Array;
  /** SHA-256(cardBytes), 64 küçük harf hex; `register_agent`'ın `agent_card_hash`'i. */
  readonly cardHash: string;
  readonly cardUrl: string;
  readonly a2aUrl: string;
  readonly did: string;
  readonly agentRecord: PublicKey;
  /** Kart ve A2A yolları için `node:http` işleyicisi; başka yol 404. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Yarım kalan görevleri kurar (`resume`) ve dinlemeye başlar. */
  listen(options: { port: number; host?: string }): Promise<Server>;
  /** Yeniden başlatmada agent işlerini kurar; `listen` bunu çağırır. */
  resume(): Promise<number>;
  close(): Promise<void>;
  /** Kaydı zincirde kurar ya da kartı / cüzdanı günceller. */
  register(options?: RegisterOptions): Promise<RegistrationResult>;
}
