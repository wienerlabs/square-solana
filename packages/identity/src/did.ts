// did:aip ayrıştırma ve biçimlendirme: v2 Solana profili (§3), v2 EVM (v2 §3.2) ve v1 (v1 §3.2).
// Ayrım segment sayısıyla yapılır (v2 §9.1): iki segment v1, dört segment v2.
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ED25519_MULTICODEC } from './constants.js';
import type { ParsedDidAip } from './types.js';

export class DidAipError extends Error {
  constructor(
    readonly code: 'invalidDid',
    message: string,
  ) {
    super(message);
    this.name = 'DidAipError';
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const EVM_REGISTRY = /^0x[0-9a-f]{40}$/;
const V1_AGENT_ID = /^[A-Za-z0-9_-]{1,32}$/;

const invalid = (did: string, reason: string) => new DidAipError('invalidDid', `${did}: ${reason}`);

/** 32–44 base58 karakter ve tam 32 bayt (Solana profili §3.2). */
function address32(value: string): boolean {
  if (value.length < 32 || value.length > 44 || !BASE58.test(value)) return false;
  return bs58.decode(value).length === 32;
}

export function parseDidAip(did: string): ParsedDidAip {
  if (!did.startsWith('did:aip:')) throw invalid(did, 'did:aip tanımlayıcısı değil');
  const segments = did.slice('did:aip:'.length).split(':');
  if (segments.length === 2) {
    const [owner, agentId] = segments as [string, string];
    if (!address32(owner)) throw invalid(did, 'v1 sahip segmenti 32 baytlık base58 anahtar değil');
    if (!V1_AGENT_ID.test(agentId)) throw invalid(did, 'v1 agent-id [A-Za-z0-9_-]{1,32} değil');
    return { version: 1, did, owner, agentId };
  }
  if (segments.length !== 4) throw invalid(did, `${segments.length} segment; v1 için 2, v2 için 4`);
  const [namespace, chain, registry, agent] = segments as [string, string, string, string];
  if (namespace === 'solana') {
    if (chain.length !== 32 || !BASE58.test(chain)) throw invalid(did, 'chain-ref 32 base58 karakter değil');
    if (!address32(registry)) throw invalid(did, 'registry 32 baytlık base58 adres değil');
    if (!address32(agent)) throw invalid(did, 'agent-record 32 baytlık base58 adres değil');
    return {
      version: 2,
      namespace: 'solana',
      did,
      chainRef: chain,
      registry,
      agentRecord: agent,
      agentRegistry: `solana:${chain}:${registry}`,
    };
  }
  if (namespace === 'eip155') {
    if (!DECIMAL.test(chain)) throw invalid(did, 'chain-id ondalık ve başta sıfırsız değil');
    if (!EVM_REGISTRY.test(registry)) throw invalid(did, 'registry küçük harfli 0x + 40 hex değil');
    if (!DECIMAL.test(agent)) throw invalid(did, 'agent-id ondalık ve başta sıfırsız değil');
    return {
      version: 2,
      namespace: 'eip155',
      did,
      chainId: chain,
      registry,
      agentId: agent,
      agentRegistry: `eip155:${chain}:${registry}`,
    };
  }
  throw invalid(did, `namespace "${namespace}" tanımlı değil (solana | eip155)`);
}

export function formatDidAip(input: { chainRef: string; registry: PublicKey; agentRecord: PublicKey }): string {
  const did = `did:aip:solana:${input.chainRef}:${input.registry.toBase58()}:${input.agentRecord.toBase58()}`;
  parseDidAip(did);
  return did;
}

/** `(agentRegistry, agentId)` → DID (Solana profili §3.5, v2 §8). Eşlenemeyen çift için null. */
export function didFromRegistration(agentRegistry: string, agentId: string): string | null {
  try {
    const parsed = parseDidAip(`did:aip:${agentRegistry}:${agentId}`);
    return parsed.version === 2 ? parsed.did : null;
  } catch {
    return null;
  }
}

/** `z` + base58btc(0xed01 || anahtar): Ed25519VerificationKey2020 ve did:key biçimi. */
export function publicKeyMultibase(address: PublicKey): string {
  return `z${bs58.encode(Uint8Array.from([...ED25519_MULTICODEC, ...address.toBytes()]))}`;
}

/** Adres bir Ed25519 açık anahtarı mı (eğri üzerinde mi). PDA'lar değildir. */
export const isOnCurve = (address: PublicKey): boolean => PublicKey.isOnCurve(address.toBytes());

/**
 * did:key → Ed25519 açık anahtarı (Solana profili §9.3): önce multibase öneki `z` atılır, sonra
 * base58 çözülür ve `0xed01` öneki denetlenip atılır.
 */
export function decodeDidKey(didKey: string): PublicKey {
  const prefix = 'did:key:z';
  if (!didKey.startsWith(prefix)) throw new DidAipError('invalidDid', `${didKey}: did:key base58btc değil`);
  const bytes = bs58.decode(didKey.slice(prefix.length));
  if (bytes.length !== 34 || bytes[0] !== ED25519_MULTICODEC[0] || bytes[1] !== ED25519_MULTICODEC[1]) {
    throw new DidAipError('invalidDid', `${didKey}: ed25519-pub did:key değil`);
  }
  return new PublicKey(bytes.slice(2));
}
