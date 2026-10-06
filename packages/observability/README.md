# @squaresdk/solana-observability

Uzun çalışan servislerin ortak gözlemlenebilirlik katmanı (BE-12): gizli veriyi maskeleyen yapılandırılmış
logger, Prometheus metrikleri, `/health` ve `/ready`, eşik alarmları. Kullanan servisler:
[`apps/prover`](../../apps/prover/), [`apps/compliance-api`](../../apps/compliance-api/). Indexer, API ve
keeper (BE-14, BE-18, BE-15) bu pakete bağımlı olarak yazılır.

| Modül | Ne verir |
|---|---|
| `logger` | `createLogger({ service, level })`: tek satır JSON (`time`, `level`, `service`, `msg`, alanlar). `debug` / `info` stdout'a, `warn` / `error` stderr'e. `child(fields)` alanları her kayda ekler; `observers` yazılan (maskelenmiş) kaydı görür |
| `redact` | Log'a yazılmadan önce maskeleme. Gizli adlı alanların değeri tümüyle; dizelerde gizli biçimlerin ilgili kısmı. Ayrıntı aşağıda |
| `metrics` | `createServiceMetrics({ service, version })`: `service` etiketli kayıt defteri, süreç metrikleri, `square_build_info`, `http_requests_total`, `http_request_duration_seconds`. `httpMetricsMiddleware` (Express uyumlu) yol şablonuyla sayar; `metricsResponse` `GET /metrics` gövdesidir |
| `health` | `createHealth({ version, checks, timeoutMs, logger })`: `live()` bağımlılıklara bakmaz, `ready()` her denetimi süre sınırıyla koşar. Yanıt API sözleşmesindeki `Health` şemasıdır; biri bile düşerse 503 (`degraded`, hepsi düşerse `down`). Sebep yanıtta değil log'dadır |
| `alarms` | `createAlarms({ rules, notifiers, logger, registry })`: kural bir değeri okur. Değer eşiğin üstünde `forSeconds` boyunca kalırsa alarm çalar, altına inince kapanır; bildirim yalnızca bu geçişlerde gider. `square_alarm_firing{alarm}` ve `square_alarm_value{alarm}` metrikleri. `createEventWindow` kayan pencere sayacıdır (ör. son bir dakikadaki hata sayısı). `webhookNotifier` olayı JSON olarak gönderir (Slack / Discord uyumlu `text` alanı); bildirim hatası servisi etkilemez |
| `config` | `parseObservabilityEnv(env)`: servislerin ortak değişkenleri. `alarmNotifiers(config)` yapılandırmadaki bildirim kanallarını verir |

## Maskeleme

- **Alan adına göre** (büyük-küçük harf, `-` ve `_`'den bağımsız): `secret`, `password`, `passphrase`,
  `token`, `apiKey`, `authorization`, `cookie`, `privateKey`, `keypair`, `mnemonic`, `seedPhrase`, `salt`
  (politika ve Travel Rule salt'ları), `witness` (politika), `credential` içeren adların değeri tümüyle
  `[REDACTED]` olur.
- **Değerin biçimine göre** (dizelerin ve hata mesajlarının içinde):
  - `Bearer` / `Basic` belirteci;
  - bağlantı adresindeki kullanıcı bilgisi (`postgres://kullanıcı:parola@`);
  - URL'deki anahtar parametreleri (`api-key`, `token`, `secret` …; ör. RPC sağlayıcısının anahtarı);
  - Stripe gizli, kısıtlı ve webhook anahtarları (`sk_`, `rk_`, `whsec_`);
  - PEM özel anahtarı;
  - keypair dosyasının 64 sayılık dizisi.
- **Diğer değerler:** Bayt dizileri içerikleri yerine uzunluklarıyla yazılır, `PublicKey` base58'iyle.
  Hata nesnelerinin mesajı, yığını ve sebebi aynı kurallardan geçer.
- **Maskelenmeyenler:** 64 baytlık base58 dizeler değerden maskelenmez: aynı biçim Solana işlem imzasıdır
  ve imzalar herkese açıktır. Gizli anahtarlar alan adından maskelenir.

## Ortam değişkenleri (servislerde ortak)

| Değişken | Açıklama |
|---|---|
| `LOG_LEVEL` | `debug`, `info`, `warn` ya da `error` |
| `HEALTH_CHECK_TIMEOUT_MS` | Tek bir hazırlık denetiminin süre sınırı |
| `ALERT_EVALUATION_SECONDS` | Alarm kurallarının değerlendirilme aralığı |
| `ALERT_WEBHOOK_URL` | İsteğe bağlı: alarm olaylarının gönderileceği JSON ucu; verilmezse alarmlar yalnızca log'a yazılır |
| `ALERT_WEBHOOK_TIMEOUT_MS` | `ALERT_WEBHOOK_URL` verilince zorunlu |

Varsayılan değer yoktur; servis açılışta doğrular. Alarm eşikleri servisin kendi değişkenleridir (ör.
`PROVER_ALERT_*`, `COMPLIANCE_ALERT_*`).

## Kaynak

Covenant'ın `app/lib/{logger,alerts,error-buffer}.ts` ve `app/app/api/{health,metrics}` dosyaları LGPL-2.1
`app/` dizinindedir. Bu dizin Square'e taşınmadığı için
([BC-03 kaydı](../../docs/legal/relicensing/README.md)) paket sıfırdan yazıldı. Metrik istemcisi
`@prometheus-io/client`'tir (Apache-2.0; `prom-client`'ın Prometheus organizasyonunca yayımlanan devamı,
`prom-client` deprecated).
