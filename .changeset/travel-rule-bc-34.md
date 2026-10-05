---
"@squaresdk/solana-sdk": minor
"@squaresdk/solana-types": minor
---

Travel Rule commitment'ı (BC-34, API sözleşmesi v0.11.0, program sözleşmesi v0.4.2):
- SDK'ya `travelRule` (`recordDigest`, `commitment`, `generateSalt`), `TRAVEL_RULE_DOMAIN` ve `flow.commitTravelRule` eklendi.
- İşlem profiline `commitTravelRule` eklendi.
- Escrow IDL'inin Travel Rule dokümanları taslaktan çıktı; SDK IDL kopyaları ve şemalar yeniden üretildi.
- `API_CONTRACT_VERSION` 0.11.0 oldu.
