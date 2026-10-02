// @squaresdk/solana-identity — did:aip v2 Solana profili (BC-14) ve v1 çözümü; BE-35 sözleşmesi (uygulama BE-09).
import type { Connection, PublicKey } from '@solana/web3.js';
import type { AgentRecordAccount } from '@squaresdk/solana-sdk';
import type { AgentCard } from '@squaresdk/solana-types';

/** `v2-solana`: did:aip:solana:{chain-ref}:{registry}:{agent-record}; `v1`: eski AIP biçimleri. */
export type DidAipProfile = 'v2-solana' | 'v1';

export interface ParsedDidAip {
  did: string;
  profile: DidAipProfile;
  /** CAIP-2 chain reference (genesis hash'in ilk 32 karakteri); v1'de null. */
  chainRef: string | null;
  registry: PublicKey;
  agentRecord: PublicKey;
}

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  service: { id: string; type: string; serviceEndpoint: string }[];
}

export interface DidResolutionResult {
  didDocument: DidDocument | null;
  didDocumentMetadata: { created?: string; updated?: string; deactivated?: boolean };
  didResolutionMetadata: { contentType?: 'application/did+ld+json'; error?: 'invalidDid' | 'notFound' | 'methodNotSupported' };
}

export interface ResolverOptions {
  connection: Connection;
  /** Bilinen kümelerin chain reference → RPC eşlemesi; yoksa `connection` kullanılır. */
  rpcByChainRef?: Readonly<Record<string, Connection>>;
  fetch?: typeof fetch;
}

/** did:aip çözümleme ve agent card doğrulama arayüzü; uygulama BE-09'da. */
export interface SquareIdentity {
  /** did:aip dizesini ayrıştırır; geçersizse hata fırlatır. */
  parseDidAip(did: string): ParsedDidAip;
  /** v2 Solana DID'i üretir. */
  formatDidAip(input: { chainRef: string; registry: PublicKey; agentRecord: PublicKey }): string;
  /** Zincirdeki `AgentRecord` ve (varsa) agent card'dan DID Document üretir. */
  buildDidDocument(record: AgentRecordAccount, card: AgentCard | null, context: { did: string; chainRef: string }): DidDocument;
  /** DID'i çözer (v2 Solana + v1). */
  resolveDid(did: string, options: ResolverOptions): Promise<DidResolutionResult>;
  /** Kartı indirir; SSRF korumalı (yalnızca https), boyut sınırlı. Ham baytlar hash doğrulaması içindir. */
  fetchAgentCard(uri: string, options?: { fetch?: typeof fetch; maxBytes?: number }): Promise<{ card: AgentCard; bytes: Uint8Array }>;
  /** SHA-256(bytes) == zincirdeki `agentCardHash`. */
  verifyAgentCardHash(bytes: Uint8Array, expectedHash: Uint8Array): boolean;
}
