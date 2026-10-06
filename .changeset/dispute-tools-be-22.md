---
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-keeper': minor
'@squaresdk/solana-indexer': patch
'@squaresdk/solana-db': minor
---

Uyuşmazlık araçları (BE-22, API sözleşmesi v0.17.0).

`@squaresdk/solana-api`: dispute kanıtı (`reason_hash` ↔ özel depodaki kanıt; kurum, agent cüzdanı / sahibi ve aktif arbitrator'lar yükler ve okur), arbitrator kuyruğu, ön denetimli `resolve_dispute` tx'i, arbitrator webhook abonelikleri ve Standard Webhooks imzalı bildirim outbox'ı (yeniden deneme, kiralama, son tarih uyarısı).

`@squaresdk/solana-keeper`: son tarihi geçmiş dispute'ların `lapse_dispute` crank'i; günlük ve metrikler talimatla (`action`) ayrılır.

`@squaresdk/solana-sdk`: `SquareApi`'ye 8 operasyon; `flow.lapseDispute`, `flow.escalateMissingProof`, `flow.updateArbitrators`.

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.17.0; kanıt, kuyruk, oy isteği, webhook ve bildirim şemaları; `disputes:write` kapsamı.

`@squaresdk/solana-indexer`: dispute aynası oy sayımını (`approval_mask`, `approval_count`, `arbitrator_set_version`), `decided_at` ve `closed_at`'i yazar ve uzlaştırır.

`@squaresdk/solana-db`: `dispute_evidence`, `arbitration_webhooks`, `notification_outbox`, `notification_cursors` tabloları; `disputes`'a yeni sütunlar.
