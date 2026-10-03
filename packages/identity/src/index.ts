// @squaresdk/solana-identity — did:aip v2 Solana profili (docs/did-aip/method-spec-v2-solana.md,
// BC-14) ve v1 çözümü; agent card indirme ve hash doğrulama (BE-09).
import { fetchAgentCard, verifyAgentCardHash } from './card.js';
import { formatDidAip, parseDidAip } from './did.js';
import { buildDidDocument } from './document.js';
import { resolveDid } from './resolve.js';
import type { SquareIdentity } from './types.js';

export * from './types.js';
export { AIP_V1_PROGRAM_ID, CHAIN_REFS } from './constants.js';
export { DidAipError, decodeDidKey, didFromRegistration, isOnCurve, publicKeyMultibase } from './did.js';

export const squareIdentity: SquareIdentity = {
  parseDidAip,
  formatDidAip,
  buildDidDocument,
  resolveDid,
  fetchAgentCard,
  verifyAgentCardHash,
};
