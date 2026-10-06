# Runbook'lar

Operasyon adımları. Her runbook bir işi baştan sona anlatır; değerlerin kaydı ağın deploy kaydındadır
([`deploy/`](../deploy/)). Alarmların tanımı [SLO'lar](../slo.md) ve [`infra/monitoring/`](../../infra/monitoring/)'dadır.

| Runbook | Ne zaman |
|---|---|
| [Program deploy ve upgrade](upgrade.md) | Program kimlikleri, ilk deploy, upgrade authority'nin Squads'a devri, config'ler, upgrade |
| [Servisler](services.md) | Veritabanı, indexer, API, keeper, prover ve web'in kurulması, yükseltilmesi, geri alınması |
| [Keeper](keeper.md) | Keeper cüzdanı, kur, alarmlar (birikim, durma, bakiye), CCTP relayer'ının takılan transferleri |
| [Screener](screener.md) | Sanctions screening: cüzdanların taranıp kaydedilmesi, süresi dolan kayıtlar, screener anahtarının rotasyonu |
