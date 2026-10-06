---
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-indexer': minor
---

Event tabanlı indexer (BE-14, API sözleşmesi v0.12.0).

`@squaresdk/solana-sdk`: `toIdlJson` (Anchor'ın çözdüğü değer → API / indexer JSON'u, sözleşme §3) ve `client.decodeTransactionEvents` (event'ler program, üst düzey talimat sırası ve talimattaki sırayla; kırpılmış log bildirilir). `decodeEvents`'in çıktısı değişmedi.

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.12.0.

`@squaresdk/solana-indexer`: ilk sürüm. Kesinleşmiş tx'lerden `chain_events` ve ayna tablolar, RPC backfill ve Helius webhook'u, idempotent işleme, zincir ↔ veritabanı uzlaştırması, `@squaresdk/solana-indexer/read` okuma API'si.
