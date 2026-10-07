# infra/monitoring

Square'in SLO panosu ve alarm kuralları (BE-33). Tanımlar, hedefler ve burn-rate politikası
[docs/slo.md](../../docs/slo.md)'dedir; buradaki dosyalar onları uygular.

| Dosya | İçerik |
|---|---|
| [`prometheus/square-slo.rules.yml`](prometheus/square-slo.rules.yml) | Kayıt kuralları: oran SLO'larının 5 dk, 30 dk, 1 saat ve 6 saatlik hata oranı. Alarmlar: burn-rate (sayfa ve bilet), senkron, birikim, canlılık ve servis içi alarmların yansıması |
| [`grafana/square-slo.json`](grafana/square-slo.json) | "Square SLO" panosu: seçili aralıkta SLO'lar; indexer, keeper, prover ve API panelleri; çalan servis alarmları. Veri kaynağı `datasource` değişkeniyle seçilir |

## Devreye alma

1. **Okuma:** Prometheus her servisin metrik portunu iç ağdan okur (`GET /metrics`). Bu portlar
   `INDEXER_METRICS_PORT`, `KEEPER_METRICS_PORT`, `PROVER_METRICS_PORT`, `API_METRICS_PORT` ve
   `COMPLIANCE_METRICS_PORT`'tur. Her seri servisin paket adını `service` etiketinde taşır; kurallar iş (job)
   adına bağlı değildir.
2. **Kurallar:** Kural dosyası Prometheus yapılandırmasının `rule_files`'ına eklenir.
3. **Yönlendirme:** Alertmanager alarmları `severity` etiketine göre yönlendirir: `critical` sayfa, `warning`
   bilet. Her alarmın `slo` etiketi docs/slo.md'deki SLO'nun adıdır.
4. **Pano:** Grafana'da JSON içe aktarılır (ya da provisioning ile yüklenir) ve Prometheus veri kaynağı
   seçilir.
5. **Servis içi alarmlar:** Servislerin kendi alarmları Prometheus'tan bağımsızdır, `ALERT_WEBHOOK_URL`'e
   gider. Eşikleri docs/slo.md'deki "Servis içi alarmlar" tablosundaki değerlerle verilir.

Ortam (devnet; mainnet yok, [ADR 0027](../../docs/decisions/0027-yalnizca-devnet.md)) ve barındırma BE-05'tedir.

## Doğrulama

```bash
node scripts/ci/monitoring.mjs
```

Bu betik kurallardaki ve panodaki her PromQL ifadesinin sözdizimini denetler. İfadelerin yalnızca servislerin
kaynakta tanımladığı serilere ya da kayıt kurallarına başvurduğunu ve histogram kovalarının (`le="…"`)
tanımlı olduğunu da kontrol eder. Testi (`scripts/ci/monitoring.test.mjs`) CI'da koşar.
