---
'@squaresdk/solana-keeper': minor
---

Finalize crank (BE-15): challenge'ı biten job'ları indexer aynasından seçer ve zincirde doğrular. Keeper ücretini işlem ücreti ve açılan hesapların rent'iyle karşılaştırır (kârlılık eşiği), priority fee'yi son ücretlerin yüzdeliğinden alır. `ProofRequired` ve temiz olmayan screening'de geri çekilerek bekler; ispat ya da screening kaydı indexlenince beklemeden yeniden dener. Kararları `keeper_actions` günlüğüne yazar.
