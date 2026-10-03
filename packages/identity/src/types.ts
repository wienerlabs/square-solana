// @squaresdk/solana-identity sözleşmesi: did:aip v2 Solana profili (docs/did-aip/method-spec-v2-solana.md)
// ve v1 çözümü. Alan adları ve kodlar spesifikasyonun §5–§6 ve §9 bölümleriyle aynıdır.
import type { Connection, PublicKey } from '@solana/web3.js';
import type { AgentCard } from '@squaresdk/solana-types';

export type ParsedDidAip =
  | {
      version: 2;
      namespace: 'solana';
      did: string;
      /** CAIP-2 Solana referansı (genesis hash'in ilk 32 karakteri). */
      chainRef: string;
      registry: string;
      agentRecord: string;
      /** `solana:{chainRef}:{registry}` (§3.5). */
      agentRegistry: string;
    }
  | {
      version: 2;
      namespace: 'eip155';
      did: string;
      chainId: string;
      registry: string;
      agentId: string;
      agentRegistry: string;
    }
  | { version: 1; did: string; owner: string; agentId: string };

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

export interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  /** v2 belgelerinde her zaman var; v1 belgelerinde yok (v1 §4.3). */
  capabilityInvocation?: string[];
  assertionMethod: string[];
  service: DidService[];
}

/** Hata kodları (§6.3): DID Resolution'ınkiler ve v2'ninkiler. */
export type DidResolutionError =
  | 'invalidDid'
  | 'notFound'
  | 'internalError'
  | 'representationNotSupported'
  | 'unsupportedVersion'
  | 'unsupportedChain'
  | 'registryNotAllowed'
  | 'networkError';

/** Kartın bütünlük sonucu (§5.5). */
export type AgentCardStatus = 'absent' | 'unavailable' | 'unverified' | 'invalid' | 'verified';

export type ResolutionWarningCode =
  | 'agentCardUnreachable'
  | 'agentCardHashMismatch'
  | 'agentCardInvalid'
  | 'crossRegistrationMalformed'
  | 'crossRegistrationLimit';

export interface ResolutionWarning {
  code: ResolutionWarningCode;
  message: string;
}

export interface DidDocumentMetadata {
  /** Hesabın okunduğu slot, ondalık dize. */
  versionId?: string;
  created?: string;
  updated?: string;
  agentStatus?: 'active' | 'inactive' | 'deregistered';
  deactivated?: true;
  deactivation?: 'deregistered' | 'inactive' | 'agentCard';
  agentRegistry?: string;
  /** CAIP-10 hesap kimlikleri, eğri üzerinde olsun olmasın. */
  owner?: string;
  agentWallet?: string;
  agentCard?: AgentCardStatus;
  agentCardUriScheme?: string;
  crossRegistrations?: { verified: string[]; unverified: string[] };
  /** v1 (§9.2, v1 §6.2). */
  deprecated?: true;
  network?: string;
  pda?: string;
  bump?: number;
}

export interface DidResolutionResult {
  didDocument: DidDocument | null;
  didDocumentMetadata: DidDocumentMetadata;
  didResolutionMetadata: {
    contentType?: 'application/did+ld+json';
    warnings?: ResolutionWarning[];
    error?: DidResolutionError;
  };
}

/** Kart indirme ayarları; sınırlar çağırandan gelir. */
export interface CardFetchOptions {
  fetch?: typeof fetch;
  /** Yanıt boyutu üst sınırı (bayt). */
  maxBytes: number;
  timeoutMs: number;
  /**
   * `ipfs://` URI'leri için https ağ geçidi tabanı (ör. `https://<gateway>/ipfs/`). Tanımlı değilse
   * ipfs kartları `unavailable` olur.
   */
  ipfsGateway?: string;
}

export interface ResolverOptions {
  /** CAIP-2 chain reference → RPC bağlantısı. Olmayan zincir `unsupportedChain`. */
  connections: Readonly<Record<string, Connection>>;
  /** §6.1 adım 5: `confirmed` ya da daha güçlü. */
  commitment: 'confirmed' | 'finalized';
  card: CardFetchOptions;
  /** Tanımlıysa yalnızca bu registry programları kabul edilir (§10.1). */
  registryAllowlist?: readonly string[];
  /** Çözüm başına gidiş-dönüş doğrulanan çapraz kayıt sayısı (v2 §8); kalanlar `unverified`. */
  crossRegistrationLimit: number;
}

/** AgentRecord'un mantıksal görünümü (§4.1), registry IDL'iyle çözülmüş. */
export interface AgentRecordView {
  creator: PublicKey;
  agentId: string;
  bump: number;
  owner: PublicKey;
  wallet: PublicKey;
  agentCardUri: string;
  agentCardHash: Uint8Array;
  status: 'active' | 'inactive' | 'deregistered';
  registeredAt: number;
  updatedAt: number;
}

/** Çözüm için geçerli kart (§5.5): JSON nesnesi; `services` ve `active` tipleri doğru. */
export interface ResolvedCard {
  services?: { name: string; endpoint: string }[];
  active?: boolean;
  registrations?: { agentRegistry: string; agentId: string }[];
}

/** did:aip çözümleme, DID belgesi ve agent card doğrulama arayüzü. */
export interface SquareIdentity {
  /** did:aip dizesini ayrıştırır; geçersizse `DidAipError('invalidDid')` fırlatır. */
  parseDidAip(did: string): ParsedDidAip;
  /** v2 Solana DID'i üretir. */
  formatDidAip(input: { chainRef: string; registry: PublicKey; agentRecord: PublicKey }): string;
  /** Kayıt ve (doğrulanmışsa) karttan DID belgesi (§5). */
  buildDidDocument(
    record: AgentRecordView,
    card: ResolvedCard | null,
    context: { did: string; chainRef: string },
  ): DidDocument;
  /** DID'i çözer (v2 Solana + v1); asla fırlatmaz, hatayı `didResolutionMetadata.error`'da döner. */
  resolveDid(did: string, options: ResolverOptions): Promise<DidResolutionResult>;
  /** Square kart şemasına uyan kartı indirir (yalnızca https / ağ geçidi, boyut ve süre sınırlı). */
  fetchAgentCard(uri: string, options: CardFetchOptions): Promise<{ card: AgentCard; bytes: Uint8Array }>;
  /** SHA-256(bytes) == zincirdeki `agentCardHash`. */
  verifyAgentCardHash(bytes: Uint8Array, expectedHash: Uint8Array): boolean;
}
