// @squaresdk/solana-identity — did:aip v2 Solana profili (BC-14) ve v1 çözümü; BE-35 imzaları.
import type { Connection, PublicKey } from '@solana/web3.js';
import type { AgentRecordAccount } from '@squaresdk/solana-sdk';
import { NotImplementedError, type AgentCard } from '@squaresdk/solana-types';

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

/** did:aip dizesini ayrıştırır; geçersizse hata fırlatır. */
export function parseDidAip(did: string): ParsedDidAip {
  throw new NotImplementedError('parseDidAip', 'BE-09');
}

/** v2 Solana DID'i üretir. */
export function formatDidAip(input: { chainRef: string; registry: PublicKey; agentRecord: PublicKey }): string {
  throw new NotImplementedError('formatDidAip', 'BE-09');
}

/** Zincirdeki `AgentRecord` ve (varsa) agent card'dan DID Document üretir. */
export function buildDidDocument(
  record: AgentRecordAccount,
  card: AgentCard | null,
  context: { did: string; chainRef: string },
): DidDocument {
  throw new NotImplementedError('buildDidDocument', 'BE-09');
}

/** DID'i çözer (v2 Solana + v1). */
export async function resolveDid(did: string, options: ResolverOptions): Promise<DidResolutionResult> {
  throw new NotImplementedError('resolveDid', 'BE-09');
}

/** Kartı indirir; SSRF korumalı (yalnızca https), boyut sınırlı. Ham baytlar hash doğrulaması içindir. */
export async function fetchAgentCard(uri: string, options?: { fetch?: typeof fetch; maxBytes?: number }): Promise<{ card: AgentCard; bytes: Uint8Array }> {
  throw new NotImplementedError('fetchAgentCard', 'BE-09');
}

/** SHA-256(bytes) == zincirdeki `agentCardHash`. */
export function verifyAgentCardHash(bytes: Uint8Array, expectedHash: Uint8Array): boolean {
  throw new NotImplementedError('verifyAgentCardHash', 'BE-09');
}
