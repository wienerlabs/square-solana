# @squaresdk/solana-screener

Sanctions screening servisi (BE-16). Cüzdanları tarar ve kararı zincirdeki screening registry'ye (BC-27,
square_registry `record_screening`) yazar. Escrow bu kaydı okur:

- `fund_job`'da kurum ve agent cüzdanı,
- `buy_claim`'de alıcı,
- release'te payee.

Kayıt `status == Clear` ve `expires_at > now` değilse işlem durur
([program arayüzü](../../docs/design/program-interface.md) §10.1, [ADR 0013](../../docs/decisions/0013-release-keeper-ucreti-iade-ve-itibar.md)).
Kaynak ve sağlayıcı seçimi: [ADR 0017](../../docs/decisions/0017-sanctions-screening-kaynaklari-ve-saglayici.md).

## Akış

1. **Kaynaklar** (`src/sources/`), aynı anda sorulur:
   - **OFAC SDN listesi** (`ofac_sdn`): Hazine Bakanlığı'nın `SDN.XML`'i periyodik indirilir. Taranan,
     `Digital Currency Address - SOL` tipindeki kimliklerdir. Kanıt: listenin SHA-256'sı, yayım tarihi
     ve eşleşen SDN kayıtları (uid, ad).
   - **Chainalysis sanctions API** (`chainalysis`, isteğe bağlı):
     `GET /api/v1/address/<adres>`. Kanıt: yanıtın SHA-256'sı ve eşleşmelerin kategori ve adı.
2. **Karar:** Kaynaklardan herhangi biri işaretlerse `flagged`, hepsi temizse `clear`. Bir kaynak yanıt
   vermezse, ya da OFAC listesi `SCREENER_OFAC_MAX_AGE_SECONDS`'ten eskiyse, karar verilmez ve tx
   gönderilmez (fail-closed). Zincirdeki eski kayıt süresi dolunca escrow'u durdurur; yanlış bir `Clear`
   yazılmaz.
3. **Kanıt ve `source_hash`:** Kanıt belgesi `{ version, wallet, sources[] }`'tir (`src/evidence.ts`).
   Zincire yazılan `source_hash` bu belgenin RFC 8785 kanonik JSON'unun SHA-256'sıdır. Belge denetim
   kaydında saklanır; zincirdeki hash ondan yeniden hesaplanarak doğrulanır. Zaman belgeye girmez: aynı
   liste sürümü ve aynı sağlayıcı yanıtı aynı hash'i verir.
4. **Zincir** (`src/chain.ts`):
   - Talimat SDK'nın registry builder'ıyla kurulur. `payer` ve `screener_authority` ikisi de authority
     anahtarıdır; `config` ve `screening_record` PDA'ları IDL'deki seed'lerden türetilir.
   - Compute unit sınırı BC-28 profilindendir (`recordScreening`).
   - Tx preflight'la gönderilir, `confirmed` commitment'la onay beklenir.
   - Onaydan sonra kayıt zincirden okunur: `screened_at` ve `expires_at` programın saatindendir.
   - RPC failover `@squaresdk/solana-hardening`'dendir.
5. **Denetim kaydı:** Her karar `screening_decisions` tablosundadır
   ([veri modeli](../../docs/design/data-model.md)). Satırda kaynak sonuçları, kanıt, `source_hash`, tx
   imzası ve slot, zincirdeki zamanlar, çağıranın anahtar parmak izi ve zaman bulunur. Sonuç üçtür:
   - `recorded`: tx onaylandı;
   - `sourceError`: karar verilmedi;
   - `txFailed`: karar verildi, tx yazılamadı. Program hatası API yanıtındadır, sebep `error`'dadır.
6. **TTL yenileme** (`src/renewal.ts`):
   - Her `SCREENER_RENEW_INTERVAL_SECONDS`'te çalışır. `expires_at`'ına `SCREENER_RENEW_MARGIN_SECONDS`'ten
     az kalmış ya da süresi geçmiş kayıtların cüzdanları yeniden taranır ve yazılır.
   - Adaylar iki kaynaktan gelir: screener'ın onaylanmış kararları ve indexer'ın aynası (`screenings`).
     Cüzdan başına en geç `expires_at` alınır.
   - Son `SCREENER_RENEW_RETRY_SECONDS` içinde denenmiş cüzdan atlanır (başarısız denemenin geri çekilmesi).
   - Pay, zincirdeki `screening_ttl_secs`'ten küçük olmalıdır; servis açılışta denetler.
   - OFAC listesi taze değilken yenileme çalışmaz.
7. **Eşzamanlılık:** Aynı cüzdanın eşzamanlı taramaları (API ve yenileme) tek taramayı paylaşır. Servis
   **tek örnek** çalışır.

Açılışta `RegistryConfig` zincirden okunur. Anahtar `screener_authority` değilse servis açılmaz; aksi halde
her tx `Unauthorized` ile düşerdi. `/ready` her denetimde bunu yeniden doğrular: authority
`update_registry_config` ile döndürülürse hazırlık düşer.

## API

Her `/v1` isteği `x-api-key` ister. Ortamda anahtarların yalnızca SHA-256'sı durur. Hız sınırı anahtar
başınadır; tarama ve okuma ayrı sayılır, sayaç Postgres'tedir. Yanıt zarfı API sözleşmesininkidir
(`{ success, data, error, meta }`). OpenAPI 3.1 belgesi `GET /openapi.json`'dadır; şemalar
`src/schemas.ts`'teki zod şemalarından üretilir.

| Yöntem | Yol | |
|---|---|---|
| POST | `/v1/screenings` | Gövde `{ "wallet": "<adres>" }`. Tarar, zincire yazar, onaylanan kararı döner |
| GET | `/v1/screenings/{wallet}` | Cüzdanın son onaylanmış kararı; yoksa 404 |
| GET | `/v1/screenings/{wallet}/history` | Denetim geçmişi: bütün kararlar ve başarısız denemeler, yeniden eskiye; `page`, `limit` (1–200) |
| GET | `/health`, `/ready` | Canlılık; hazırlık: veritabanı, RPC ve registry config (authority eşleşmesi), taze OFAC listesi |
| GET | `/metrics` | `SCREENER_METRICS_PORT`'ta, iç ağ |

| HTTP | `error.code` | Ne zaman |
|---|---|---|
| 400 | `invalid_input` | Gövde, adres ya da sorgu geçersiz |
| 401 | `unauthorized` | `x-api-key` yok ya da kayıtlı değil |
| 429 | `rate_limited` | Hız sınırı; `Retry-After` |
| 502 | `tx_failed` | Karar verildi, tx yazılamadı. `programError` (ör. registry `Unauthorized`), `details.decisionId` |
| 503 | `source_unavailable` | Bir kaynak yanıt vermedi ya da liste bayat; karar verilmedi. `details.decisionId` |
| 503 | `db_unavailable` | Veritabanına ulaşılamıyor |

## Anahtar saklama

Screener authority anahtarı `RegistryConfig.screener_authority`'nin imzalayan anahtarıdır.
`record_screening`'de hem imzacı hem fee payer'dır. Anahtar ve Chainalysis API anahtarı **repoya,
imaja ve `.env` dosyalarına girmez**. Çalışma anında secret store'dan gelir. İki yol var, yalnızca biri
verilir:

1. **Ortam değişkeni** `SCREENER_AUTHORITY_KEYPAIR`: solana-keygen JSON'u (64 baytlık dizi). Railway'de
   servis değişkeni olarak tanımlanır ve "sealed" yapılır: değer arayüzde ve API'de bir daha görünmez.
2. **Secret dosyası** `SCREENER_AUTHORITY_KEYPAIR_PATH`: secret store'un konteynere bağladığı dosyanın yolu
   (Docker/Kubernetes secret, ör. `/run/secrets/screener-authority.json`). Dosya yalnızca servis kullanıcısı
   (uid 1001) tarafından okunabilir olmalı (`600`). İzin grup ya da herkes için açıksa servis açılır ama
   `authority_keypair` uyarısı loglar.

Anahtarı üretmek ve kaydetmek:

```bash
# Repo dışında, geçici bir dizinde:
solana-keygen new --no-bip39-passphrase --silent -o /tmp/screener-authority.json
solana-keygen pubkey /tmp/screener-authority.json     # RegistryConfig.screener_authority olacak adres
# Dosyanın içeriği secret store'a (Railway sealed değişken ya da secret dosyası) yüklenir, yerel kopya silinir.
shred -u /tmp/screener-authority.json
```

- **Kayıt:** Açık anahtar zincire admin'in (Squads vault, BC-09) `init_registry_config` ya da
  `update_registry_config` talimatıyla yazılır.
- **Bakiye:** Anahtar ücretleri ve yeni kayıtların rent'ini öder. Bakiye
  `screener_authority_balance_lamports` metriğindedir; `SCREENER_ALERT_MIN_BALANCE_LAMPORTS`'in altına
  inince `screener_low_balance` alarmı çalar.
- **Rotasyon:**
  1. Yeni anahtar üretilir.
  2. Admin `update_registry_config` ile yeni açık anahtarı yazar.
  3. Servisin secret'ı yeni anahtarla değiştirilip yeniden başlatılır.
  4. Eski anahtarın kalan bakiyesi çekilir.

  2 ile 3 arasında eski anahtarla gönderilen tx'ler `Unauthorized` (preflight) ile reddedilir. Bunlar
  `txFailed` olarak kaydedilir; yenileme sonra yeniden dener.
- **Sızma:** Anahtar sızarsa saldırgan herhangi bir cüzdan için `Clear` yazabilir. Admin hemen
  `update_registry_config` ile authority'yi değiştirir. Denetim kaydı ve `ScreeningRecorded` event'leri,
  screener'ın yazmadığı kararları ayırt etmeye yarar: zincirdeki imza denetim kaydında yoktur.
- **Loglar:** `secretKey`, `keypair`, `apiKey` gibi alanlar `@squaresdk/solana-observability`'nin
  logger'ında maskelenir. Anahtarın hata mesajlarında değeri yer almaz. Chainalysis anahtarı yalnızca
  isteğin başlığında gider.

## Çalıştırma

Migration'lar ve `programs` tablosunun seed'i screener'dan önce db paketiyle uygulanır (indexer'ınkiyle
aynı; [indexer README](../indexer/README.md#çalıştırma)). Ortam değişkenleri [`.env.example`](.env.example)'dadır;
varsayılan değer yoktur. İmaj: `docker build -f apps/screener/Dockerfile .` (repo kökünden).

**Metrikler:**
- Kararlar: `screener_decisions_total{trigger, outcome, status}`.
- Kaynaklar: `screener_source_checks_total{source, result}`.
- OFAC listesi: `screener_ofac_entries`, `screener_ofac_sol_addresses`, `screener_ofac_loaded_timestamp_seconds`.
- Yenileme: `screener_renewal_candidates`, `screener_last_renewal_timestamp_seconds`.
- Bakiye ve hatalar: `screener_authority_balance_lamports`, `screener_errors_total{stage}`.

**Alarmlar:**
- `screener_errors` (kritik): kaynak ve tx hataları pencerede eşiğin üstünde.
- `screener_ofac_stale` (kritik): liste `SCREENER_OFAC_MAX_AGE_SECONDS`'tir yenilenemedi; tarama yapılamıyor.
- `screener_low_balance` (uyarı): authority bakiyesi eşiğin altında.

## Testler

`pnpm --filter @squaresdk/solana-screener test`. Veritabanı testleri Postgres konteyneri açar (Docker
gerekir). Testlerin dayanakları:

- **Zincir:** yerel JSON-RPC fixture'ı (`test/fixtures/rpc.ts`). Gönderilen tx'i çözer ve registry'nin
  kurallarını uygular: imzalar, IDL'deki hesap sırası, PDA'lar, imzacının `screener_authority` olması.
  Geçerli tx'te `ScreeningRecord`'u IDL coder'ıyla yazar.
- **Tx üretimi:** `test/chain.test.ts`, talimatı repo kökündeki sözleşme IDL'iyle
  (`idl/square_registry_contract.json`) çözer: discriminator, argümanlar, hesaplar ve imzacı/yazılabilir
  bayrakları, compute budget ve imza.
- **OFAC:** commit'lenmiş sentetik fikstür (`test/fixtures/sdn.xml`); gerçek liste repoda değildir.
- **Chainalysis:** sahte `fetch`.

## Kalanlar

- **Gerçek ağda deneme:** devnet'te gerçek registry programıyla deneme ve fonlamanın gerçek reddi
  (`ScreeningFlagged` / `ScreeningExpired`) BE-36'dadır (localnet).
- **Gerçek uçlara karşı smoke testi:** OFAC'ın canlı `SDN.XML` ucuna ve Chainalysis API'sine karşı
  smoke testi dağıtımda yapılır. Chainalysis için kayıtla alınan bir API anahtarı gerekir.
- **Dağıtım:** Railway servisi ve secret tanımı dağıtım işidir.
