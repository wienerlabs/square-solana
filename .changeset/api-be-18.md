---
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-indexer': patch
---

REST API (BE-18, API sözleşmesi v0.13.0).

`@squaresdk/solana-api`: ilk sürüm. Cüzdan Ed25519 oturumu ve API anahtarları, indexer tablolarından okuma uçları, 8 adımın imzasız tx hazırlığı, S3 uyumlu depoya teslimat yükleme, agent card barındırma ve A2A keşif yolu, politika meta verisi (kurum anahtarı ya da Squads multisig'inin Initiate yetkili üyeleri), prover vekili, `GET /openapi.json`, hız sınırı.

`@squaresdk/solana-sdk`: `createApiClient` ve `ApiClientError` (REST istemcisi), `putAgentCard`'a `agentId` seçeneği, `fromIdlJson` ve `IdlJsonError` (IDL JSON → Anchor değeri).

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.13.0.

`@squaresdk/solana-indexer`: `cardVerified` kartın hash'inin zincirdeki güncel `agentCardHash`'e eşitliğidir; kayıttan önce barındırılan kart, kayıt indexlenince doğrulanmış olur.
