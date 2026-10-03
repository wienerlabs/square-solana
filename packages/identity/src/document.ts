// DID belgesi üretimi: v2 Solana profili §5 ve v1 §4.
import type { PublicKey } from '@solana/web3.js';
import { DID_CONTEXT, DID_CONTEXT_V1 } from './constants.js';
import { isOnCurve, publicKeyMultibase } from './did.js';
import type { AgentRecordView, DidDocument, DidService, ResolvedCard, VerificationMethod } from './types.js';

const method = (did: string, fragment: string, key: PublicKey): VerificationMethod => ({
  id: `${did}#${fragment}`,
  type: 'Ed25519VerificationKey2020',
  controller: did,
  publicKeyMultibase: publicKeyMultibase(key),
});

/** v2 §4.5: küçük harf, [a-z0-9] dışı her karakter `-`. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '-');

/** Kartın servisleri (§5.4): tekrar eden slug'lara dizi sırasıyla -2, -3 …; kendine işaret eden DID atlanır. */
function cardServices(did: string, card: ResolvedCard, used: Set<string>): DidService[] {
  return (card.services ?? [])
    .filter((service) => !(service.name === 'DID' && service.endpoint === did))
    .map((service) => {
      const base = slug(service.name);
      let fragment = base;
      for (let n = 2; used.has(fragment); n += 1) fragment = `${base}-${n}`;
      used.add(fragment);
      return { id: `${did}#${fragment}`, type: service.name, serviceEndpoint: service.endpoint };
    });
}

/**
 * Kayıt ve (yalnızca `verified` ise) karttan v2 DID belgesi. `Deregistered` kayıtta ilişki ve
 * servis dizileri boştur (§5.6).
 */
export function buildDidDocument(
  record: AgentRecordView,
  card: ResolvedCard | null,
  context: { did: string; chainRef: string },
): DidDocument {
  const { did, chainRef } = context;
  const controller = `did:pkh:solana:${chainRef}:${record.owner.toBase58()}`;
  const base = { '@context': [...DID_CONTEXT], id: did, controller };
  if (record.status === 'deregistered') {
    return {
      ...base,
      verificationMethod: [],
      authentication: [],
      capabilityInvocation: [],
      assertionMethod: [],
      service: [],
    };
  }
  const owner = isOnCurve(record.owner) ? method(did, 'owner', record.owner) : null;
  const wallet = isOnCurve(record.wallet) ? method(did, 'agent-wallet', record.wallet) : null;
  const ownerRef = owner ? [owner.id] : [];
  const services: DidService[] = [];
  const used = new Set<string>();
  if (record.agentCardUri !== '') {
    services.push({ id: `${did}#agent-card`, type: 'AIPAgentCard', serviceEndpoint: record.agentCardUri });
    used.add('agent-card');
  }
  if (card) services.push(...cardServices(did, card, used));
  return {
    ...base,
    verificationMethod: [owner, wallet].filter((m): m is VerificationMethod => m !== null),
    authentication: ownerRef,
    capabilityInvocation: ownerRef,
    assertionMethod: [owner, wallet].filter((m): m is VerificationMethod => m !== null).map((m) => m.id),
    service: services,
  };
}

/** v1 belgesi (v1 §4): her zaman kendi kendini kontrol eder; anahtar `wallet_address`'ten. */
export function buildV1Document(did: string, walletAddress: PublicKey, endpoint: string): DidDocument {
  const key = method(did, 'key-1', walletAddress);
  return {
    '@context': [...DID_CONTEXT_V1],
    id: did,
    controller: did,
    verificationMethod: [key],
    authentication: [key.id],
    assertionMethod: [key.id],
    service: [{ id: `${did}#agent-endpoint`, type: 'AIPAgentEndpoint', serviceEndpoint: endpoint }],
  };
}
