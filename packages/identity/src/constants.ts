// did:aip spesifikasyonlarının normatif sabitleri. Yapılandırma değil, yöntemin parçasıdır:
// docs/did-aip/method-spec-v2-solana.md (Solana profili) ve onun atıf verdiği v1 / v2 metinleri.

/** Kümelerin CAIP-2 Solana referansları: genesis hash'in ilk 32 karakteri (Solana profili §3.3). */
export const CHAIN_REFS = Object.freeze({
  mainnetBeta: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
});

/**
 * did:aip v1'in tek dağıtımı, devnet'te (Solana profili §9.2). v1 DID'leri ağ belirtmez; v1 çözümü
 * her zaman devnet'i kullanır ve bu program hiçbir zaman v2 `registry` segmenti olarak kabul edilmez.
 */
export const AIP_V1_PROGRAM_ID = 'CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc';

export const DID_CONTEXT = Object.freeze([
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/ed25519-2020/v1',
]);

/** v1 belgelerinin bağlamı (v1 §4.6). */
export const DID_CONTEXT_V1 = Object.freeze([...DID_CONTEXT, 'https://aip.network/ns/agent/v1']);

export const DID_CONTENT_TYPE = 'application/did+ld+json';

/** multicodec `ed25519-pub` öneki (did:key ve `publicKeyMultibase`). */
export const ED25519_MULTICODEC = Object.freeze([0xed, 0x01]);
