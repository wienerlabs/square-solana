---
'@squaresdk/solana-screener': minor
'@squaresdk/solana-db': minor
---

Sanctions screening servisi (BE-16, ADR 0020).

`@squaresdk/solana-screener`: ilk sürüm. Cüzdanı OFAC SDN listesi ("Digital Currency Address - SOL") ve
yapılandırılmışsa Chainalysis sanctions API ile tarar; kaynaklardan biri işaretlerse karar `flagged`. Karar
screener authority anahtarıyla registry `record_screening` tx'i olarak yazılır (`source_hash` kanıt
belgesinin RFC 8785 SHA-256'sı), `expires_at`'ı yaklaşan kayıtlar yeniden taranır (TTL yenileme), her karar
denetim kaydına girer. API: `POST /v1/screenings`, `GET /v1/screenings/{wallet}`,
`GET /v1/screenings/{wallet}/history`, `GET /openapi.json`.

`@squaresdk/solana-db`: `screening_decisions` tablosu ve `ScreeningTrigger` / `ScreeningOutcome` enum'ları
(migration `20261006170000_screener`).
