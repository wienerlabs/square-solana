# Ortamlar, değişkenler ve secret'lar

**Issue:** BE-05 (#19) · **Karar:** [ADR 0002](decisions/0002-web-hosting-railway.md) (web ve servisler Railway'de)

Bu belgenin tabloları `node scripts/ci/env-inventory.mjs` ile üretilir ve CI'da denetlenir; elle düzenlenmez.

## Ortamlar

| Ortam | Railway environment | Küme | Not |
|---|---|---|---|
| PR preview | PR Environments (PR başına, kapanınca silinir) | devnet | yalnızca web ve API; secret'lar staging'den, ayrı anahtarlarla |
| Staging | `staging` | devnet | bütün servisler ([runbook](runbooks/upgrade.md), BC-30) |
| Production | `production` | mainnet | dış audit sonrası (BE-34, BC-42) |

Her servis bir Railway servisidir; derleme ve sağlık denetimi `apps/<servis>/railway.json`'dadır
(`node scripts/ci/railway.mjs` üretir, CI denetler).

## Secret politikası

1. **Repoda secret yok.** `.env*` dosyaları `.gitignore`'dadır (`.env.example` hariç, değerleri boştur);
   gitleaks pre-commit kancası ve CI keypair dosyalarını, 64 baytlık gizli anahtarları ve bilinen sağlayıcı
   anahtarlarını yakalar ([docs/ci.md](ci.md#sır-taraması)).
2. **Secret'lar Railway'de "sealed" değişkendir.** Değer bir kez yazılır, arayüzde ve API'de okunamaz; yalnızca
   servisin süreci görür. Aşağıda **secret** işaretli her değişken böyle tutulur; diğerleri normal değişkendir.
3. **Ortam başına ayrı değer.** Staging ve production aynı anahtarı, veritabanını ya da RPC sağlayıcı anahtarını
   paylaşmaz; PR ortamları staging'in secret'larını değil kendi kısıtlı anahtarlarını kullanır.
4. **İmzalayan anahtarlar** (keeper, screener authority, fee payer sponsoru, MPP authority, x402 fee payer)
   yalnızca kendi rolünü taşır ve ücret için gereken SOL'den fazlasını tutmaz. Program upgrade authority'si ve
   config admin'i hiçbir servis anahtarı değildir: 2-of-3 Squads vault'udur ([ADR 0008](decisions/0008-upgrade-authority-2-of-3-squads.md)).
5. **Rotasyon:** sızma şüphesinde aynı gün; düzenli olarak 90 günde bir. Zincirde yetkisi olan anahtarın
   rotasyonu önce zincirdeki yetkiyi (ör. registry `screener_authority`) yeni anahtara taşır, sonra eski
   değeri siler. Servisler açılışta anahtarın zincirdeki yetkiyle eşleştiğini denetler.
6. **Hash'lenmiş değerler** (`*_SHA256`) secret değildir: servis yalnızca izinli anahtarların özetini tutar.
7. **Açılışta doğrulama:** her servis ortamı `src/config.ts`'teki zod şemasıyla okur; eksik ya da geçersiz
   değerde süreç başlamaz. Bu belgedeki listeler şemalarla ve `.env.example` dosyalarıyla CI'da eşlenir.

## Servisler

### api

`apps/api/.env.example` · 53 değişken, 8 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `DATABASE_URL` | Veritabanı (zorunlu) | **secret** |  |
| `API_PORT` | Sunucu (zorunlu) |  |  |
| `API_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (API_PORT'tan farklı) |
| `API_PUBLIC_BASE_URL` | Sunucu (zorunlu) |  | API'nin dış adresi (https): agent card URI'leri ve OpenAPI `servers`; en çok 123 karakter |
| `CORS_ORIGINS` | Sunucu (zorunlu) |  | Virgülle ayrılmış izinli origin'ler (web uygulaması) |
| `API_TRUST_PROXY_HOPS` | Sunucu (zorunlu) |  | İstemci IP'si için güvenilen vekil sayısı (Railway önünde 1) |
| `API_JSON_MAX_BYTES` | Sunucu (zorunlu) |  | JSON gövde sınırı (bayt) |
| `API_RPC_URLS` | Solana RPC (zorunlu) | **secret** | Virgülle ayrılmış http(s) uçları; hata veren uç API_RPC_COOLDOWN_MS boyunca atlanır |
| `API_RPC_TIMEOUT_MS` | Solana RPC (zorunlu) |  |  |
| `API_RPC_COOLDOWN_MS` | Solana RPC (zorunlu) |  |  |
| `API_AUTH_DOMAIN` | Oturum (zorunlu) |  | İmzalanan mesajdaki alan adı (ör. app.example.com) |
| `API_AUTH_CHALLENGE_TTL_SECONDS` | Oturum (zorunlu) |  |  |
| `API_SESSION_TTL_SECONDS` | Oturum (zorunlu) |  |  |
| `API_RATE_LIMIT_WINDOW_SECONDS` | Hız sınırı (zorunlu) |  |  |
| `API_RATE_LIMIT_READ` | Hız sınırı (zorunlu) |  |  |
| `API_RATE_LIMIT_WRITE` | Hız sınırı (zorunlu) |  |  |
| `API_DELIVERY_S3_ENDPOINT` | Teslimat deposu, S3 uyumlu (zorunlu) |  |  |
| `API_DELIVERY_S3_REGION` | Teslimat deposu, S3 uyumlu (zorunlu) |  |  |
| `API_DELIVERY_S3_BUCKET` | Teslimat deposu, S3 uyumlu (zorunlu) |  | Teslimatların kovası; nesneleri herkese açık okunur |
| `API_DELIVERY_S3_ACCESS_KEY_ID` | Teslimat deposu, S3 uyumlu (zorunlu) | **secret** | Depoya yazma kimliği (yalnızca bu kovaya PutObject ve HeadBucket yetkisi yeterli) |
| `API_DELIVERY_S3_SECRET_ACCESS_KEY` | Teslimat deposu, S3 uyumlu (zorunlu) | **secret** | Kimliğin gizli anahtarı |
| `API_DELIVERY_S3_FORCE_PATH_STYLE` | Teslimat deposu, S3 uyumlu (zorunlu) |  | true \| false (yol biçimli adresleme) |
| `API_DELIVERY_PUBLIC_BASE_URL` | Teslimat deposu, S3 uyumlu (zorunlu) |  | Nesnelerin herkese açık taban adresi; deliveryUri = <taban>/<workHash>, en çok 63 karakter |
| `API_DELIVERY_MAX_BYTES` | Teslimat deposu, S3 uyumlu (zorunlu) |  |  |
| `API_EVIDENCE_S3_BUCKET` | Dispute kanıtı (zorunlu, BE-22) |  | Kanıtların kovası: teslimat deposuyla aynı uç nokta ve kimlik; herkese açık OKUNMAZ (kanıt API'den indirilir) |
| `API_EVIDENCE_MAX_BYTES` | Dispute kanıtı (zorunlu, BE-22) |  |  |
| `API_ARBITRATOR_CACHE_SECONDS` | Dispute kanıtı (zorunlu, BE-22) |  | Escrow config'inden okunan arbitrator setinin önbellek süresi |
| `API_SECRET_BOX_KEYS` | Arbitrator bildirimleri (zorunlu, BE-22) | **secret** | Webhook sırlarının şifreleme anahtar halkası: kimlik:base64,kimlik:base64 (her anahtar 32 bayt; openssl rand -base64 32) ve yeni değerleri şifreleyen anahtarın kimliği |
| `API_SECRET_BOX_ACTIVE_KEY` | Arbitrator bildirimleri (zorunlu, BE-22) |  |  |
| `API_NOTIFY_INTERVAL_MS` | Arbitrator bildirimleri (zorunlu, BE-22) |  | Outbox turu aralığı ve tur başına en fazla teslimat |
| `API_NOTIFY_BATCH_SIZE` | Arbitrator bildirimleri (zorunlu, BE-22) |  |  |
| `API_NOTIFY_TIMEOUT_MS` | Arbitrator bildirimleri (zorunlu, BE-22) |  | Bir teslimatın süre sınırı; aşan ya da 2xx dışı dönen teslimat yeniden denenir |
| `API_NOTIFY_MAX_ATTEMPTS` | Arbitrator bildirimleri (zorunlu, BE-22) |  |  |
| `API_NOTIFY_BACKOFF_BASE_SECONDS` | Arbitrator bildirimleri (zorunlu, BE-22) |  | Yeniden deneme: ilk bekleme, her denemede ikiye katlanır, üst sınır |
| `API_NOTIFY_BACKOFF_MAX_SECONDS` | Arbitrator bildirimleri (zorunlu, BE-22) |  |  |
| `API_NOTIFY_DEADLINE_WARNING_SECONDS` | Arbitrator bildirimleri (zorunlu, BE-22) |  | Son tarihe bu kadar saniye kala oy vermemiş arbitrator'lara dispute.deadline gönderilir |
| `API_NOTIFY_ALLOW_INSECURE` | Arbitrator bildirimleri (zorunlu, BE-22) |  | true yalnızca geliştirmede: webhook ucu http ve özel ağ adresi olabilir |
| `API_LOOKUP_TABLE` | Tx hazırlama |  | İsteğe bağlı: Square address lookup table'ı (BC-28); verilirse her tx'e eklenir |
| `API_COMPUTE_UNIT_PRICE` | Tx hazırlama |  | Zorunlu: computeUnitPrice verilmeyen tx'lerin priority fee'si (mikro-lamport / CU) |
| `API_PROVER_URL` | Prover vekili (zorunlu) |  |  |
| `API_PROVER_API_KEY` | Prover vekili (zorunlu) | **secret** | API'nin prover'a gönderdiği servis anahtarı (prover'ın PROVER_API_KEY_SHA256 listesinde) |
| `API_PROVER_TIMEOUT_MS` | Prover vekili (zorunlu) |  |  |
| `API_TRAVEL_RULE_KEYS` | Travel Rule (zorunlu, BE-23) | **secret** | Ana anahtar halkası: virgülle kimlik:base64 (her anahtar 32 bayt; ör. openssl rand -base64 32). Secret yöneticisinden verilir, repoya yazılmaz. |
| `API_TRAVEL_RULE_ACTIVE_KEY_ID` | Travel Rule (zorunlu, BE-23) |  | Yeni kayıtları ve yeniden sarmayı yapan anahtarın kimliği (halkada olmalı) |
| `API_TRAVEL_RULE_RETENTION_DAYS` | Travel Rule (zorunlu, BE-23) |  | Kaydın son yazmadan sonra saklandığı gün sayısı (hukuki karar) |
| `API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS` | Travel Rule (zorunlu, BE-23) |  | Silme ve yeniden sarma aralığı |
| `API_ALERT_ERRORS` | Alarmlar (zorunlu) |  |  |
| `API_ALERT_ERROR_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |

### compliance-api

`apps/compliance-api/.env.example` · 41 değişken, 11 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `COMPLIANCE_API_PORT` | Sunucu (zorunlu) |  |  |
| `COMPLIANCE_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (COMPLIANCE_API_PORT'tan farklı) |
| `NODE_ENV` | Sunucu (zorunlu) |  | development \| test \| production |
| `LOG_LEVEL` | Sunucu (zorunlu) |  | debug \| info \| warn \| error |
| `CORS_ORIGINS` | Sunucu (zorunlu) |  | Virgülle ayrılmış izinli origin URL'leri (en az bir tane) |
| `POSTGRES_HOST` | PostgreSQL (zorunlu) |  |  |
| `POSTGRES_PORT` | PostgreSQL (zorunlu) |  |  |
| `POSTGRES_USER` | PostgreSQL (zorunlu) |  |  |
| `POSTGRES_PASSWORD` | PostgreSQL (zorunlu) | **secret** |  |
| `POSTGRES_DB` | PostgreSQL (zorunlu) |  |  |
| `STRIPE_SECRET_KEY` | Stripe / MPP (zorunlu) | **secret** |  |
| `STRIPE_API_VERSION` | Stripe / MPP (zorunlu) |  |  |
| `MPP_SECRET_KEY` | Stripe / MPP (zorunlu) | **secret** |  |
| `MPP_REALM` | Stripe / MPP (zorunlu) |  |  |
| `MPP_REPORT_PRICE_CENTS` | Stripe / MPP (zorunlu) |  | /api/v1/compliance/mpp-report fiyatı (en küçük birim) ve ISO 4217 para birimi (küçük harf) |
| `MPP_REPORT_CURRENCY` | Stripe / MPP (zorunlu) |  |  |
| `STRIPE_WEBHOOK_SECRET` | Stripe / MPP (isteğe bağlı; tanımlı değilse ilgili uç 503 döner) | **secret** | Webhook imza anahtarı (whsec_…) |
| `STRIPE_PUBLISHABLE_KEY` | Stripe / MPP (isteğe bağlı; tanımlı değilse ilgili uç 503 döner) |  | Tarayıcıya verilen yayımlanabilir anahtar (pk_test_… / pk_live_…) |
| `MPP_AUTHORITY_KEYPAIR_BASE58` | Stripe / MPP (isteğe bağlı; tanımlı değilse ilgili uç 503 döner) | **secret** | Kanonik makbuzları imzalayan 64 baytlık Solana keypair'i (base58 ya da JSON dizi) |
| `SOLANA_RPC_URL` | Solana (zorunlu) | **secret** |  |
| `VERIFIER_PROGRAM` | Solana (zorunlu) |  | square-verifier program kimliği |
| `X402_NETWORK` | x402 (zorunlu; @squaresdk/solana-x402, BE-24) |  | CAIP-2 kimliği ya da v1 adı: solana \| solana-devnet (CAIP-2'ye çevrilir) |
| `X402_PAYMENT_MINT` | x402 (zorunlu; @squaresdk/solana-x402, BE-24) |  |  |
| `X402_PUBLISHER_WALLET` | x402 (zorunlu; @squaresdk/solana-x402, BE-24) |  |  |
| `X402_REPORT_PRICE` | x402 (zorunlu; @squaresdk/solana-x402, BE-24) |  | /api/v1/compliance/protected-report fiyatı (ödeme mint'inin taban birimi) |
| `DATABASE_URL` | x402 (zorunlu; @squaresdk/solana-x402, BE-24) | **secret** | Square'in tek veritabanı (db/): ödeme yüklerinin tekrar korumaları `replay_guards` tablosunda |
| `X402_FEE_PAYER_KEYPAIR` | x402 facilitator (ADR 0018) | **secret** | Boşsa kendi facilitator'ımız: işlem ücretini aşağıdaki cüzdan öder, SOLANA_RPC_URL ile doğrular ve gönderir. Yalnızca SOL tutan, X402_PUBLISHER_WALLET'tan ayrı 64 baytlık keypair (base58 ya da JSON dizi) |
| `X402_FACILITATOR_URL` | x402 facilitator (ADR 0018) |  | Doluysa harici x402 facilitator'ı (…/verify, …/settle, …/supported) ve isteğe bağlı bearer belirteci |
| `X402_FACILITATOR_TOKEN` | x402 facilitator (ADR 0018) | **secret** |  |
| `HELIUS_API_KEY` | Kayıtsız ödeme izleyicisi | **secret** | İsteğe bağlı: tanımlıysa izleyici çalışır ve HELIUS_API_URL zorunludur |
| `HELIUS_API_URL` | Kayıtsız ödeme izleyicisi |  |  |
| `COMPLIANCE_WATCHER_INTERVAL_MS` | Kayıtsız ödeme izleyicisi |  | Zorunlu (ms; en az 5000) |
| `COMPLIANCE_WATCHER_MINTS` | Kayıtsız ödeme izleyicisi |  | İsteğe bağlı: virgülle ayrılmış mint listesi; tanımlı değilse tüm SPL transferleri izlenir |
| `COMPLIANCE_STRIPE_RECONCILE_DELAY_MS` | Kayıtsız ödeme izleyicisi |  | Zorunlu (ms) |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  | Zorunlu: tek bir hazırlık denetiminin süre sınırı (ms) |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  | Zorunlu: alarm kurallarının değerlendirilme aralığı (saniye) |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (@squaresdk/solana-observability) | **secret** | İsteğe bağlı: alarm olaylarının gönderileceği JSON ucu; tanımlıysa ALERT_WEBHOOK_TIMEOUT_MS zorunludur |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  |  |
| `COMPLIANCE_ALERT_ERRORS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  | Zorunlu: compliance_errors alarmı (penceredeki hata log'u sayısı eşiği ve pencere, saniye) |
| `COMPLIANCE_ALERT_ERROR_WINDOW_SECONDS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  |  |
| `COMPLIANCE_ALERT_DB_DOWN_SECONDS` | Gözlemlenebilirlik (@squaresdk/solana-observability) |  | Zorunlu: compliance_database_down alarmı (veritabanı bu kadar saniye yanıt vermezse) |

### fee-payer

`apps/fee-payer/.env.example` · 26 değişken, 4 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `DATABASE_URL` | Veritabanı (zorunlu) | **secret** |  |
| `FEE_PAYER_PORT` | Sunucu (zorunlu) |  |  |
| `FEE_PAYER_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (FEE_PAYER_PORT'tan farklı) |
| `CORS_ORIGINS` | Sunucu (zorunlu) |  | Virgülle ayrılmış izinli origin'ler (web uygulaması) |
| `FEE_PAYER_TRUST_PROXY_HOPS` | Sunucu (zorunlu) |  | İstemci IP'si için güvenilen vekil sayısı (Railway önünde 1) |
| `FEE_PAYER_JSON_MAX_BYTES` | Sunucu (zorunlu) |  | JSON gövde sınırı (bayt); base64 tx en çok ~1650 bayt |
| `FEE_PAYER_RPC_URLS` | Solana RPC (zorunlu) | **secret** | Virgülle ayrılmış http(s) uçları; hata veren uç FEE_PAYER_RPC_COOLDOWN_MS boyunca atlanır |
| `FEE_PAYER_RPC_TIMEOUT_MS` | Solana RPC (zorunlu) |  |  |
| `FEE_PAYER_RPC_COOLDOWN_MS` | Solana RPC (zorunlu) |  |  |
| `FEE_PAYER_SECRET_KEY` | Sponsor anahtarı (zorunlu, gizli) | **secret** | 64 baytlık Ed25519 gizli anahtarı, base58. Platformun gizli değişkeni olarak verilir; repoya, imaja ve log'a girmez. Ayrı, yalnızca ücret için tutulan bir sıcak cüzdandır (ADR 0019 §Anahtar). |
| `FEE_PAYER_ALLOWED_INSTRUCTIONS` | Politika |  | İsteğe bağlı: izinli talimatlar `<program>:<talimat>` (virgülle); boşsa ADR 0019'nin varsayılan listesi |
| `FEE_PAYER_MAX_COMPUTE_UNIT_PRICE` | Politika |  | Zorunlu: priority fee tavanı (mikro-lamport / CU) |
| `FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT` | Politika |  | Zorunlu: tx başına compute unit sınırı tavanı (en çok 1400000) |
| `FEE_PAYER_MAX_LAMPORTS_PER_TX` | Bütçe (zorunlu, lamport) |  | Tek tx'in en yüksek maliyeti (ücret + rent) |
| `FEE_PAYER_USER_DAILY_LAMPORTS` | Bütçe (zorunlu, lamport) |  | Kullanıcı (cüzdan) başına günlük bütçe, UTC günü |
| `FEE_PAYER_GLOBAL_DAILY_LAMPORTS` | Bütçe (zorunlu, lamport) |  | Bütün kullanıcıların günlük toplamı |
| `FEE_PAYER_RATE_LIMIT_WINDOW_SECONDS` | Hız sınırı (zorunlu) |  |  |
| `FEE_PAYER_RATE_LIMIT` | Hız sınırı (zorunlu) |  | Pencere başına istek (kullanıcı başına) |
| `FEE_PAYER_MIN_BALANCE_LAMPORTS` | Alarmlar (zorunlu) |  | Sponsor bakiyesi bunun altına düşünce `fee_payer_balance_low` çalar (lamport) |
| `FEE_PAYER_ALERT_ERRORS` | Alarmlar (zorunlu) |  |  |
| `FEE_PAYER_ALERT_ERROR_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |

### indexer

`apps/indexer/.env.example` · 23 değişken, 3 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `DATABASE_URL` | Veritabanı (zorunlu) | **secret** |  |
| `INDEXER_RPC_URLS` | Solana RPC (zorunlu) | **secret** | Virgülle ayrılmış http(s) uçları; ilki tercih edilir, hata veren uç INDEXER_RPC_COOLDOWN_MS boyunca atlanır |
| `INDEXER_RPC_TIMEOUT_MS` | Solana RPC (zorunlu) |  |  |
| `INDEXER_RPC_COOLDOWN_MS` | Solana RPC (zorunlu) |  |  |
| `INDEXER_PORT` | Sunucu (zorunlu) |  | /health, /ready ve webhook |
| `INDEXER_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (INDEXER_PORT'tan farklı) |
| `INDEXER_POLL_INTERVAL_MS` | Tarama ve uzlaştırma (zorunlu) |  |  |
| `INDEXER_SIGNATURE_PAGE_SIZE` | Tarama ve uzlaştırma (zorunlu) |  | getSignaturesForAddress sayfa boyu (1–1000) |
| `INDEXER_RECONCILE_INTERVAL_SECONDS` | Tarama ve uzlaştırma (zorunlu) |  |  |
| `INDEXER_WEBHOOK_AUTH_SHA256` | Helius webhook (isteğe bağlı) |  | Helius'a verilen Authorization değerinin SHA-256'sı (64 hex). Boşsa webhook ucu kapalı. |
| `INDEXER_WEBHOOK_MAX_BODY_BYTES` | Helius webhook (isteğe bağlı) |  | Yukarıdaki verilince zorunlu: |
| `INDEXER_WEBHOOK_MAX_PENDING` | Helius webhook (isteğe bağlı) |  |  |
| `INDEXER_WEBHOOK_PENDING_TTL_SECONDS` | Helius webhook (isteğe bağlı) |  |  |
| `INDEXER_ALERT_STALL_SECONDS` | Alarmlar (zorunlu) |  |  |
| `INDEXER_ALERT_LAG_SLOTS` | Alarmlar (zorunlu) |  |  |
| `INDEXER_ALERT_DRIFT` | Alarmlar (zorunlu) |  |  |
| `INDEXER_ALERT_ERRORS` | Alarmlar (zorunlu) |  |  |
| `INDEXER_ALERT_ERROR_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |

### keeper

`apps/keeper/.env.example` · 26 değişken, 4 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `DATABASE_URL` | Veritabanı (zorunlu) | **secret** |  |
| `KEEPER_RPC_URLS` | Solana RPC (zorunlu) | **secret** | Virgülle ayrılmış http(s) uçları; hata veren uç KEEPER_RPC_COOLDOWN_MS boyunca atlanır |
| `KEEPER_RPC_TIMEOUT_MS` | Solana RPC (zorunlu) |  |  |
| `KEEPER_RPC_COOLDOWN_MS` | Solana RPC (zorunlu) |  |  |
| `KEEPER_SECRET_KEY` | Keeper cüzdanı (zorunlu) | **secret** | 64 baytlık gizli anahtar, base58. Ücreti alır; işlem ücretini ve açılan hesapların rent'ini öder. |
| `KEEPER_PORT` | Sunucu (zorunlu) |  | /health ve /ready |
| `KEEPER_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (KEEPER_PORT'tan farklı) |
| `KEEPER_POLL_INTERVAL_MS` | Crank (zorunlu) |  |  |
| `KEEPER_CONFIRM_POLL_MS` | Crank (zorunlu) |  | Gönderilen tx'in onay yoklama aralığı |
| `KEEPER_BATCH_SIZE` | Crank (zorunlu) |  | Bir turda değerlendirilen en fazla job |
| `KEEPER_BACKOFF_BASE_SECONDS` | Crank (zorunlu) |  | Bekletilen job'un ilk yeniden deneme aralığı (her tekrarda ikiye katlanır) ve üst sınırı |
| `KEEPER_BACKOFF_MAX_SECONDS` | Crank (zorunlu) |  |  |
| `KEEPER_MINT_UNITS_PER_SOL` | Kârlılık ve priority fee (zorunlu) |  | 1 SOL'ün settlement mint'inin taban birimindeki karşılığı (ör. USDC, 1 SOL = 150 USD: 150000000) |
| `KEEPER_MIN_MARGIN_BPS` | Kârlılık ve priority fee (zorunlu) |  | Keeper ücretinin maliyeti aşması gereken pay (baz puan); 0 başa baş |
| `KEEPER_PRIORITY_FEE_PERCENTILE` | Kârlılık ve priority fee (zorunlu) |  | Priority fee: job'un yazılabilir hesaplarının son ücretlerinin yüzdeliği (0-100) ve üst sınırı (mikro-lamport / CU) |
| `KEEPER_MAX_COMPUTE_UNIT_PRICE` | Kârlılık ve priority fee (zorunlu) |  |  |
| `KEEPER_ALERT_MIN_BALANCE_LAMPORTS` | Alarmlar (zorunlu) |  |  |
| `KEEPER_ALERT_STALL_SECONDS` | Alarmlar (zorunlu) |  |  |
| `KEEPER_ALERT_DUE_SECONDS` | Alarmlar (zorunlu) |  |  |
| `KEEPER_ALERT_ERRORS` | Alarmlar (zorunlu) |  |  |
| `KEEPER_ALERT_ERROR_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |

### prover

`apps/prover/.env.example` · 19 değişken, 1 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `PROVER_SERVICE_PORT` | Sunucu (zorunlu) |  |  |
| `PROVER_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (PROVER_SERVICE_PORT'tan farklı) |
| `CORS_ORIGINS` | Sunucu (zorunlu) |  | Virgülle ayrılmış izinli origin'ler |
| `PROVER_API_KEY_SHA256` | Yetki (zorunlu) |  | İzinli API anahtarlarının SHA-256'sı (64 küçük harf hex, virgülle); anahtarın kendisi ortamda tutulmaz |
| `PROVER_MAX_CONCURRENT` | Kuyruk (zorunlu) |  | Aynı anda üretilen en fazla ispat; sırada bekleyebilecek en fazla istek (dolunca 503); bekleme sınırı (ms) |
| `PROVER_MAX_QUEUE` | Kuyruk (zorunlu) |  |  |
| `PROVER_QUEUE_TIMEOUT_MS` | Kuyruk (zorunlu) |  |  |
| `PROVER_MANIFEST_PATH` | Devre artefaktları (zorunlu) |  | circuits/payment-compliance/artifacts/manifest.json; wasm ve zkey'in SHA-256'ları açılışta bununla karşılaştırılır |
| `PROVER_WASM_PATH` | Devre artefaktları (zorunlu) |  |  |
| `PROVER_ZKEY_PATH` | Devre artefaktları (zorunlu) |  |  |
| `PROVER_ALERT_QUEUE_DEPTH` | Alarmlar (zorunlu) |  | prover_queue_backlog: sıradaki istek PROVER_ALERT_QUEUE_DEPTH'in üstünde PROVER_ALERT_QUEUE_SECONDS kalırsa |
| `PROVER_ALERT_QUEUE_SECONDS` | Alarmlar (zorunlu) |  |  |
| `PROVER_ALERT_FAILURES` | Alarmlar (zorunlu) |  | prover_failures: iç hatayla biten ispat PROVER_ALERT_FAILURE_WINDOW_SECONDS içinde PROVER_ALERT_FAILURES'ı aşarsa |
| `PROVER_ALERT_FAILURE_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |

### screener

`apps/screener/.env.example` · 35 değişken, 5 secret

| Değişken | Bölüm | Secret | Not |
|---|---|---|---|
| `DATABASE_URL` | Veritabanı (zorunlu) | **secret** |  |
| `SCREENER_PORT` | Sunucu (zorunlu) |  | API, /health ve /ready |
| `SCREENER_METRICS_PORT` | Sunucu (zorunlu) |  | Yalnızca iç ağdan erişilen /metrics portu (SCREENER_PORT'tan farklı) |
| `SCREENER_API_KEY_SHA256` | Sunucu (zorunlu) |  | İzinli API anahtarlarının SHA-256'sı (64 küçük harf hex, virgülle): printf %s "$ANAHTAR" \| shasum -a 256 |
| `SCREENER_JSON_MAX_BYTES` | Sunucu (zorunlu) |  |  |
| `SCREENER_RATE_LIMIT_WINDOW_SECONDS` | Sunucu (zorunlu) |  |  |
| `SCREENER_RATE_LIMIT_SCREEN` | Sunucu (zorunlu) |  | Pencere başına tarama (her biri bir tx) ve okuma isteği, anahtar başına |
| `SCREENER_RATE_LIMIT_READ` | Sunucu (zorunlu) |  |  |
| `SCREENER_RPC_URLS` | Solana RPC ve tx (zorunlu) | **secret** | Virgülle ayrılmış http(s) uçları; ilki tercih edilir, hata veren uç SCREENER_RPC_COOLDOWN_MS boyunca atlanır |
| `SCREENER_RPC_TIMEOUT_MS` | Solana RPC ve tx (zorunlu) |  |  |
| `SCREENER_RPC_COOLDOWN_MS` | Solana RPC ve tx (zorunlu) |  |  |
| `SCREENER_COMPUTE_UNIT_PRICE` | Solana RPC ve tx (zorunlu) |  | Priority fee (mikro-lamport / CU) |
| `SCREENER_CONFIRM_POLL_MS` | Solana RPC ve tx (zorunlu) |  |  |
| `SCREENER_AUTHORITY_KEYPAIR` | Screener authority anahtarı (yalnızca biri, zorunlu; SECRET) | **secret** | solana-keygen JSON'u (64 baytlık dizi). Değer secret store'dan enjekte edilir. |
| `SCREENER_AUTHORITY_KEYPAIR_PATH` | Screener authority anahtarı (yalnızca biri, zorunlu; SECRET) |  | ya da bağlanan secret dosyasının yolu (izin 600), ör. /run/secrets/screener-authority.json |
| `SCREENER_OFAC_SDN_URL` | OFAC SDN listesi (zorunlu) |  | ör. https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML |
| `SCREENER_OFAC_REFRESH_SECONDS` | OFAC SDN listesi (zorunlu) |  |  |
| `SCREENER_OFAC_MAX_AGE_SECONDS` | OFAC SDN listesi (zorunlu) |  | Son başarılı indirmenin üstünden bu kadar saniye geçerse tarama yapılmaz (REFRESH'ten büyük) |
| `SCREENER_OFAC_TIMEOUT_MS` | OFAC SDN listesi (zorunlu) |  |  |
| `SCREENER_OFAC_MAX_BYTES` | OFAC SDN listesi (zorunlu) |  |  |
| `SCREENER_CHAINALYSIS_API_KEY` | Chainalysis sanctions API (isteğe bağlı, ADR 0020; anahtar SECRET) | **secret** | Boşsa yalnızca OFAC listesi taranır. Anahtar verilince URL ve süre zorunlu. |
| `SCREENER_CHAINALYSIS_URL` | Chainalysis sanctions API (isteğe bağlı, ADR 0020; anahtar SECRET) |  | ör. https://public.chainalysis.com |
| `SCREENER_CHAINALYSIS_TIMEOUT_MS` | Chainalysis sanctions API (isteğe bağlı, ADR 0020; anahtar SECRET) |  |  |
| `SCREENER_RENEW_INTERVAL_SECONDS` | TTL yenileme (zorunlu) |  |  |
| `SCREENER_RENEW_MARGIN_SECONDS` | TTL yenileme (zorunlu) |  | expires_at'a bu kadar saniye kalan kayıt yeniden taranır (zincirdeki screening_ttl_secs'ten küçük) |
| `SCREENER_RENEW_BATCH` | TTL yenileme (zorunlu) |  |  |
| `SCREENER_RENEW_RETRY_SECONDS` | TTL yenileme (zorunlu) |  |  |
| `SCREENER_ALERT_ERRORS` | Alarmlar (zorunlu) |  |  |
| `SCREENER_ALERT_ERROR_WINDOW_SECONDS` | Alarmlar (zorunlu) |  |  |
| `SCREENER_ALERT_MIN_BALANCE_LAMPORTS` | Alarmlar (zorunlu) |  |  |
| `LOG_LEVEL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  | debug \| info \| warn \| error |
| `HEALTH_CHECK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_EVALUATION_SECONDS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
| `ALERT_WEBHOOK_URL` | Gözlemlenebilirlik (servislerde ortak, zorunlu) | **secret** | İsteğe bağlı JSON alarm ucu; verilirse ALERT_WEBHOOK_TIMEOUT_MS zorunlu |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Gözlemlenebilirlik (servislerde ortak, zorunlu) |  |  |
