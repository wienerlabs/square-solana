---
'@squaresdk/solana-indexer': minor
'@squaresdk/solana-keeper': minor
---

SLO ölçümleri (BE-33). Indexer: canlı tx'in blok zamanından yazılmasına geçen süre (`indexer_ingest_delay_seconds`), senkron gecikmesi (`indexer_sync_lag_slots`) ve `indexer_lagging` alarmı (`INDEXER_ALERT_LAG_SLOTS`). Keeper: challenge bitişinden finalize onayına geçen süre (`keeper_finalize_delay_seconds{gate}`), finalize edilebilir durumda bekleyen job'lar (`keeper_due_jobs`, `keeper_oldest_due_seconds`) ve `keeper_backlog` alarmı (`KEEPER_ALERT_DUE_SECONDS`). İki yeni ortam değişkeni zorunludur.
