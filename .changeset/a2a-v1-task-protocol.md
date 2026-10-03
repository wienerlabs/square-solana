---
'@squaresdk/solana-types': minor
'@squaresdk/solana-a2a': minor
---

A2A görev protokolü v1.0 (BE-17, sözleşme v0.6.0).

`@squaresdk/solana-types`: A2A şemaları v1.0'a hizalandı ve geriye uyumsuz değişti. Görev durumları
ProtoJSON adlarıdır (`TASK_STATE_SUBMITTED` …), `TaskSchema` v1.0 görevidir (`TaskStatus`, `Message`,
`Artifact`, geçmiş). Mesaj, parça, akış olayı, yöntem istek ve yanıtı, JSON-RPC zarfı ve hata kodu
şemaları eklendi. `JOB_STATUS_TO_TASK_STATE` kesinleşti: teslimden sonraki job durumları görevi
`COMPLETED` bırakır, ödeme durumu `metadata.square.jobStatus`'tadır.

`@squaresdk/solana-a2a`: ilk sürüm. JSON-RPC sunucusu (`createA2aServer`) ve istemcisi
(`createA2aClient`), SSE akışları, görevi açan mesajın zincirdeki job'a bağlanması, görev ↔ job durum
kuralları, API anahtarıyla kimlik ve `@squaresdk/solana-a2a/prisma` altında Postgres görev deposu.
