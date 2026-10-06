---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-db': minor
---

Travel Rule kaydı (BE-23, API sözleşmesi v0.15.0, ADR 0017). API kaydı zarf şifrelemesiyle saklar (AES-256-GCM, döndürülebilir ana anahtar halkası) ve `commitTravelRule`'un salt'lı commitment'ını döner. Kaydı kurumun güncel yetkilisi ve onun izin verdiği cüzdanlar okur. Kişisel veriye dokunan her işlem erişim kaydına yazılır; kayıt saklama süresi dolunca silinir. Yeni uçlar: `putTravelRule`, `getTravelRule`, `createTravelRuleGrant`, `deleteTravelRuleGrant`, `listTravelRuleAccess`. Yeni zorunlu ortam değişkenleri: `API_TRAVEL_RULE_KEYS`, `API_TRAVEL_RULE_ACTIVE_KEY_ID`, `API_TRAVEL_RULE_RETENTION_DAYS`, `API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS`.
