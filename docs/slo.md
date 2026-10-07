# Hizmet düzeyi hedefleri (SLO) ve hata bütçesi

Square servislerinin "sağlıklı" tanımı sayılarla yazılır: her gösterge (SLI) servislerin `GET /metrics`'te
yayımladığı bir seridir, hedef (SLO) o serinin 30 günlük kayan penceredeki payıdır. Panolar ve alarmlar bu
tanımları uygular: [`infra/monitoring/`](../infra/monitoring/).

> **Durum:** devnet; Square yalnızca devnet'te çalışır ([ADR 0027](decisions/0027-yalnizca-devnet.md)). Sayılar
> başlangıç değeridir ve birkaç haftalık devnet verisiyle ayarlanır. Değişiklik bu dosyada ve kural dosyasında birlikte yapılır.

## Göstergeler (SLI)

| # | Gösterge | Seri | Ölçüm |
|---|---|---|---|
| 1 | Indexer tazeliği | `indexer_ingest_delay_seconds` | Canlı tx'in blok zamanından ayna tablolara yazılmasına geçen süre. İmleçsiz ilk taramadaki geçmiş tx'ler (backfill) ölçülmez. Blok zamanı olmayan tx ölçülmez |
| 2 | Indexer senkronu | `indexer_sync_lag_slots`, `indexer_last_poll_timestamp_seconds` | Tarama başındaki kesinleşmiş uçla, bütün programların eksiksiz tarandığı son uç arasındaki fark (slot). Okunamayan bir tx'te duran tarama eksiksiz sayılmaz |
| 3 | Keeper finalize gecikmesi | `keeper_finalize_delay_seconds{gate}` | Challenge bitişinden finalize'ın onayına geçen süre. `gate="none"` politikasız iş; `gate="proof"` politikalı iş, kurumun ispatı bağlama süresi de girer |
| 4 | Keeper birikimi | `keeper_oldest_due_seconds`, `keeper_due_jobs` | Finalize edilebilir durumda bekleyen en eski job'un bekleme süresi. İspat, screening ya da kârlılık beklemesi sayılmaz; beklenen kayıt indexlenince süre o andan başlar |
| 5 | Prover erişilebilirliği ve verimi | `prover_proofs_total{result}` | `capacity` (kuyruk dolu) ve `error` sonuçlarının tüm isteklere oranı. Verim `ok` sonuçlarının dakikalık hızıdır, doyum `prover_queued_requests` ve `prover_active_proofs`'tur |
| 6 | Prover ispat süresi | `prover_proving_seconds` | Başarılı ispatın witness, ispat ve doğrulama süresi |
| 7 | API erişilebilirliği | `http_requests_total{service="@squaresdk/solana-api",status}` | 5xx yanıtların payı |
| 8 | API gecikmesi | `http_request_duration_seconds{service="@squaresdk/solana-api"}` | İstek süresi |
| 9 | Uzlaştırma sapması | `indexer_reconcile_drift{table}` | Zincirle ayna tablolar arasındaki sapma (missing, stale, orphaned) |

Gösterge 3 uçtan uca süredir. Keeper'ın kendi gecikmesi 4'tür: politikalı işte ispat gelene kadar geçen süre
keeper'a yazılmaz, ispat indexlenince sayaç başlar.

## Hedefler (SLO)

30 günlük kayan pencere. Bütçe `1 − hedef`'tir.

| SLO | Hedef | 30 günlük bütçe | Gerekçe |
|---|---|---|---|
| `indexer_freshness` | Canlı tx'lerin **%99**'u 60 s içinde indexlenir | %1 | Kesinleşme ~13 s ekler (32 slot); kalan tarama aralığı ve RPC'dir |
| `indexer_sync` | Dakikaların **%99,5**'inde gecikme ≤ 150 slot (~60 s) | ~3,6 saat | Gösterge 1 yalnızca işlenen tx'i görür; takılı kalan tarama burada görünür |
| `keeper_finalize` | Politikasız işlerin **%99**'u challenge bitişinden 600 s içinde onaylanır | %1 | Tur aralığı, onay ve bir geri çekilme adımı. Politikalı iş bilgi amaçlı izlenir |
| `keeper_backlog` | Dakikaların **%99,5**'inde en eski bekleyen ≤ 600 s | ~3,6 saat | Keeper'ın kendi gecikmesi; RPC ve program hataları burada birikir |
| `prover_availability` | İsteklerin **%99**'u kapasite ya da iç hata yüzünden reddedilmez | %1 | Reddedilen istek kurumun ispatı bağlamasını geciktirir |
| `prover_latency` | Başarılı ispatların **%95**'i ≤ 5 s | %5 | Bağlamada ispatın anı zincir saatinden en fazla 600 s uzak olabilir (ADR 0012); süre bu payı tüketmemeli |
| `api_availability` | Yanıtların **%99,5**'i 5xx değildir | %0,5 | Web ve agent'ların okuma ve yazma yolu |
| `api_latency` | İsteklerin **%99**'u ≤ 1 s | %1 | |
| Uzlaştırma bütünlüğü | Sapma **0** | yok | Kesin hedef: bütçesizdir |

Kesin hedefte (uzlaştırma) onarılmayan her sapma Sev-1'dir: ayna tablolara bağlı yazmalar durur ve olay
sonrası inceleme yazılır. Zincirde çift ödeme ve süresi geçmiş escrow programın kurallarıyla engellenir
(`finalize_payment`, ADR 0013); izleme bunların aynaya yansımasını denetler.

## Hata bütçesi ve burn-rate

Oran tabanlı SLO'larda (1, 3, 5–8) alarmlar SRE Workbook'un çok pencereli burn-rate yöntemidir. Burn-rate,
hata oranının bütçeye oranıdır; 1 olan hız bütçeyi tam 30 günde bitirir.

| Alarm | Koşul | Anlamı | Önem |
|---|---|---|---|
| `SLOBurnRate_<slo>_page` | 1 saatte ve son 5 dakikada burn > 14,4 | 1 saatte bütçenin %2'si | `critical`: sayfa |
| `SLOBurnRate_<slo>_ticket` | 6 saatte ve son 30 dakikada burn > 6 | 6 saatte bütçenin %5'i | `warning`: aynı gün bilet |

Kısa pencere, sorun geçince alarmın hemen kapanmasını sağlar. Zaman tabanlı SLO'lar (2, 4) ve canlılık eşik
ve süreyle alarmdır:

| Alarm | Koşul | Önem |
|---|---|---|
| `IndexerLagging` | Gecikme > 150 slot, 10 dk | `warning` |
| `IndexerStalled` | Son başarılı taramadan beri > 300 s | `critical` |
| `IndexerMetricsAbsent` | Indexer metrikleri 10 dk yok | `critical` |
| `KeeperBacklog` | En eski bekleyen > 600 s, 5 dk | `critical` |
| `KeeperStalled` | Son başarılı turdan beri > 300 s | `critical` |
| `KeeperMetricsAbsent` | Keeper metrikleri 10 dk yok | `critical` |
| `ProverQueueBacklog` | Kuyruk 10 dk boşalmıyor | `warning` |
| `ServiceAlarmFiring` | Bir servisin kendi eşik alarmı çalıyor (`square_alarm_firing`) | `warning` |

**Bütçe tükenirse:** O yüzeye özellik eklenmez. Yalnızca güvenilirlik değişiklikleri yapılır; SLO yeniden
sağlanana ve olay sonrası inceleme yazılana kadar bu sürer.

## Servis içi alarmlar

Servisler Prometheus'tan bağımsız olarak kendi eşik alarmlarını değerlendirir ve `ALERT_WEBHOOK_URL`'e
bildirir (`@squaresdk/solana-observability`). Eşikler ortamdandır. SLO'larla aynı sınırda çalmaları için
değerler şöyledir:

| Değişken | Değer | SLO |
|---|---|---|
| `INDEXER_ALERT_LAG_SLOTS` | 150 | `indexer_sync` |
| `INDEXER_ALERT_STALL_SECONDS` | 300 | `indexer_sync` |
| `INDEXER_ALERT_DRIFT` | 0 | Uzlaştırma bütünlüğü |
| `KEEPER_ALERT_DUE_SECONDS` | 600 | `keeper_backlog` |
| `KEEPER_ALERT_STALL_SECONDS` | 300 | `keeper_backlog` |

Diğer eşikler (`*_ALERT_ERRORS`, `KEEPER_ALERT_MIN_BALANCE_LAMPORTS`, `PROVER_ALERT_*`) SLO'ya bağlı değildir:
hata sayısı ve bakiye ortamın yüküne göre seçilir.

## Panolar ve alarmlar

- [`infra/monitoring/prometheus/square-slo.rules.yml`](../infra/monitoring/prometheus/square-slo.rules.yml):
  her oran SLO'sunun 5 dk, 30 dk, 1 saat ve 6 saatlik hata oranı (`slo:<slo>:error_ratio_rate<pencere>`),
  burn-rate ve eşik alarmları.
- [`infra/monitoring/grafana/square-slo.json`](../infra/monitoring/grafana/square-slo.json): seçili aralıkta
  SLO'lar ve servis başına gecikme, verim ve hata panelleri.
- `node scripts/ci/monitoring.mjs`: kurallardaki ve panodaki her PromQL ifadesinin sözdizimini denetler. İfadeler
  yalnızca servislerin yayımladığı serilere başvurmalı, başvurulan histogram kovaları da tanımlı olmalı.
  Testi `scripts/ci` testleriyle CI'da koşar.

Devreye alma dağıtımla yapılır (BE-05):
- Prometheus servislerin metrik portlarını iç ağdan okur.
- Kural dosyası `rule_files`'a eklenir.
- Alertmanager `severity`'ye göre yönlendirir: `critical` sayfa, `warning` bilet.
- Grafana panoyu içe aktarır.

Kurulum notları: [`infra/monitoring/README.md`](../infra/monitoring/README.md).

## İnceleme

SLO'lar ayda bir gerçek veriyle gözden geçirilir. Hedef ya da sınır değişirse bu dosya, kural dosyası, pano ve
yukarıdaki ortam değerleri birlikte güncellenir.

## Bilinen eksikler

- **API ve web canlılığı:** Dışarıdan bir uptime yoklamasıyla (`/health`) ölçülmüyor. Gösterge 7 yalnızca
  servise ulaşan istekleri görür. Yoklama dağıtımla eklenir.
- **Prover kapasitesi:** Kapasite metrik olarak yayımlanmıyor (`PROVER_MAX_CONCURRENT` yapılandırmadır).
  Doyum, kuyruktan ve etkin ispat sayısından okunur.
- **Politikalı işin uçtan uca süresi:** Kurumun ispatı bağlamasını içerdiği için SLO değildir. Bağlama
  süresinin ayrı bir göstergesi kurum tarafı izlenince eklenir.

## Kaynak

Yapı (göstergeler, hedefler, bütçe, burn-rate politikası) Covenant'ın `docs/SLO.md`'sinden (C-114) alındı.
Göstergeler ve sayılar Square'in servisleri ve Solana akışı için yeniden tanımlandı: kesinleşme, keeper'ın
`ProofRequired` beklemesi ve prover kuyruğu.
