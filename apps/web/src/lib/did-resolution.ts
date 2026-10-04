// did:aip çözümü (FE-05): @squaresdk/solana-identity'nin çözücüsü, uygulamanın doğrulanmış RPC
// bağlantısıyla. Kayıt zincirden okunur, kart kendi adresinden indirilip hash'i doğrulanır; API ya da
// indexer gerekmez. Çözücü yalnızca bağlantının zincirindeki DID'leri çözer (profil §6.1 adım 3).
import type { Connection } from '@solana/web3.js';
import {
  squareIdentity,
  type AgentCardStatus,
  type DidResolutionError,
  type DidResolutionResult,
} from '@squaresdk/solana-identity';
import type { Tone } from '@/components/ui/status-badge';
import { CARD_FETCH, chainRefOf } from './agent-registration';

/** Çözüm başına gidiş-dönüş doğrulanan çapraz kayıt sayısı (v2 §8). */
export const CROSS_REGISTRATION_LIMIT = 3;

export function resolveAgentDid(
  did: string,
  connection: Connection,
  genesisHash: string,
): Promise<DidResolutionResult> {
  return squareIdentity.resolveDid(did, {
    connections: { [chainRefOf(genesisHash)]: connection },
    commitment: 'confirmed',
    card: CARD_FETCH,
    crossRegistrationLimit: CROSS_REGISTRATION_LIMIT,
  });
}

export const RESOLUTION_ERRORS: Readonly<Record<DidResolutionError, string>> = {
  invalidDid: 'This is not a valid did:aip identifier.',
  notFound: 'No agent record exists for this DID.',
  internalError: 'The resolver failed on this record.',
  representationNotSupported: 'This representation is not supported.',
  unsupportedVersion: 'This did:aip version is not supported.',
  unsupportedChain: 'The DID is on another network than the one this app is connected to.',
  registryNotAllowed: 'The DID names a registry this resolver does not accept, such as the did:aip v1 program.',
  networkError: 'The RPC could not be reached.',
};

export const CARD_STATUS: Readonly<Record<AgentCardStatus, { label: string; tone: Tone }>> = {
  verified: { label: 'Card verified', tone: 'success' },
  absent: { label: 'No card', tone: 'neutral' },
  unavailable: { label: 'Card unreachable', tone: 'warning' },
  unverified: { label: 'Card hash mismatch', tone: 'danger' },
  invalid: { label: 'Card invalid', tone: 'danger' },
};
