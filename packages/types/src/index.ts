// @squaresdk/solana-types — API ve SDK sözleşmesinin ortak tipleri (BE-35, BE-07; sürüm API_CONTRACT_VERSION).
export * from './primitives.js';
export * from './generated/idl.js';
export * from './envelope.js';
export * from './views.js';
export * from './agent-card.js';
export * from './policy-document.js';
export * from './a2a.js';
export * from './events.js';
export * from './operations.js';

/** BE-35 API / SDK sözleşme sürümü (docs/design/api-sdk-contract.md değişiklik kaydı). */
export const API_CONTRACT_VERSION = '0.4.0';
