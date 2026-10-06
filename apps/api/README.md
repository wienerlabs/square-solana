# @squaresdk/solana-api

Square'in REST API servisi (BE-18). Sözleşme [`docs/api/openapi.yaml`](../../docs/api/openapi.yaml)'dır
(37 operasyon); servis `GET /openapi.json`'da sözleşmenin derlenmiş halini yayımlar. Web uygulaması ve
entegrasyonlar SDK'nın `createApiClient`'ıyla bağlanır.

| Etiket | Uygulama |
|---|---|
| auth | Cüzdan Ed25519 oturumu ve API anahtarları ([Kimlik](#kimlik)) |
| okuma | Job, kurum, politika, agent, alacak, dispute, screening ve event görünümleri indexer'ın tablolarından (`@squaresdk/solana-indexer/read`); keeper günlüğü `keeper_actions`'tan |
| tx | 8 adımın imzasız v0 tx'i ([Tx hazırlama](#tx-hazırlama)) |
| teslimat | Dosya S3 uyumlu depoya yüklenir; `submit_work`'ün `workHash` ve `deliveryUri`'si döner ([Teslimat](#teslimat)) |
| agent card | Barındırma ve A2A keşif yolu `/a/{agentRecord}/.well-known/agent-card.json` ([Agent card](#agent-card)) |
| politika meta | Herkese açık ad, açıklama ve etiketler; yazan kurumun güncel yetkilisi |
| travel rule | Kaydın şifreli saklanması, commitment'ı, izinli okuma ve erişim kaydı ([Travel Rule](#travel-rule)) |
| cctp | Burn'ün job'a kaydı, transferin durumu, kurumun mint + fonlama tx'i ([CCTP](#cctp)) |
| prover | `POST /v1/prove`, prover servisine (apps/prover) vekil |

Tüm `/v1` yanıtları `{ success, data, error, meta }` zarfıyla döner; `meta.requestId` yanıtın `X-Request-Id`
başlığıyla aynıdır. Zamanlar Unix saniyesidir.

## Kimlik

- **Oturum:** `POST /v1/auth/challenge` cüzdanın imzalayacağı mesajı verir:

  ```
  <API_AUTH_DOMAIN> wants you to sign in with your Solana account:
  <cüzdan>

  Sign in to Square.

  Nonce: <16 rastgele bayt, base64url>
  Issued At: <ISO 8601>
  Expiration Time: <ISO 8601>
  ```

  `POST /v1/auth/session` Ed25519 imzasını (base58) doğrular ve belirteç verir.
  - Nonce tek kullanımlıktır; aynı imza ikinci oturum açamaz.
  - Belirteç `sqs_` + 32 rastgele bayttır; veritabanında yalnızca SHA-256'sı durur.
  - Belirteç `Authorization: Bearer` başlığıyla gönderilir; `DELETE /v1/auth/session` oturumu kapatır.
- **API anahtarı:** Oturumla oluşturulur; kapsamlar `read`, `tx:prepare`, `deliveries:write`, `agents:write`,
  `prove`.
  - Anahtar `sqk_` + 32 rastgele bayttır ve yalnızca oluşturma yanıtında bir kez döner.
  - Listelemede ilk 12 karakteri (`prefix`) görünür.
  - Anahtar `X-API-Key` başlığıyla gönderilir. İki başlık birlikte gönderilemez.
- **Uçların yetkisi** (OpenAPI `security`):

  | Uçlar | Yetki |
  |---|---|
  | Anahtar yönetimi, oturum kapatma, politika meta | Oturum |
  | `uploadDelivery`, `putAgentCard`, `prepareTx` | Oturum ya da kapsamlı anahtar |
  | `prove` | Yalnızca `prove` kapsamlı anahtar |
  | Okuma uçları | Açık; anahtarla gelen istek `read` ister |

  Geçersiz bir kimlik herkese açık uçta da 401 alır.
- **Hız sınırı:** Okuma ve yazma uçları ayrı kurallarla sınırlanır. Kimliği olan istekte cüzdan başına,
  olmayanda istemci IP'si başına sayılır. Sayaç Postgres'te paylaşılır (`@squaresdk/solana-hardening`).
  Yanıtta `RateLimit-*` başlıkları döner, sınırı aşan istek 429 ve `Retry-After` alır.

## Tx hazırlama

- **İstek:** `call` (program, instruction, IDL JSON argümanları) ve `accounts` (yalnızca türetilemeyen hesaplar:
  imzacılar, token hesapları, dış hesaplar).
- **Argümanlar** SDK'nın `fromIdlJson`'uyla Anchor değerine çevrilir; geçersiz alan yoluyla 400 alır.
- **PDA'lar ve sabit adresler** Anchor'ın çözücüsüyle sunucuda bulunur. Çözücü gerekirse zincirdeki hesabı okur
  (ör. `acceptJob`'da job'dan `agentRecord`). Çözülemeyen hesap 400 alır.
- **Compute unit sınırı:** BC-28 profilindeki talimatlarda profilin değeridir. Profilde olmayanlarda tx bir kez
  simüle edilir; sınır ölçümün iki katıdır, 10 bine yukarı yuvarlanır (profilin yöntemi).
- **Priority fee:** İstekteki `computeUnitPrice`, verilmezse `API_COMPUTE_UNIT_PRICE`.
- **ALT:** `API_LOOKUP_TABLE` verilirse Square address lookup table'ı her tx'e eklenir.
- **Simülasyon:** Her tx simüle edilir. Düşecek tx 422 `simulation_failed` alır; zincir hatası `programError`'da
  `(program, code, IDL adı)` olarak döner.

## Teslimat

- **Depolama:** Dosya `multipart/form-data`'nın `file` alanıyla gelir ve S3 uyumlu depoya (AWS S3, Cloudflare R2,
  MinIO …) yazılır.
  - Anahtar içeriğin SHA-256'sıdır (`workHash`).
  - `deliveryUri`, `<API_DELIVERY_PUBLIC_BASE_URL>/<workHash>`'tir: deponun herkese açık adresi, Covenant'ın
    teslimat akışındaki gibi.
  - Kovanın nesneleri herkese açık okuması dağıtımda ayarlanır; adres içeriği doğrular.
- **Yükleyen:** Job'un agent cüzdanı (`submit_work`'ü imzalayan) ya da agent kaydının sahibi.
- **Boyut:** `API_DELIVERY_MAX_BYTES` ile sınırlı; sınırı aşan gövde belleğe alınmadan reddedilir.
- **Tekrar:** Aynı job'a aynı içerik yeniden yüklenirse aynı makbuz döner.

## Agent card

- **Yazan:** Kayıt sahibi.
  - Kayıt indexlenmişse `AgentRecord.owner`.
  - Kart kayıttan önce yüklenir (8 adımın 2.si). Bu durumda `?agentId=` (`register_agent`'ın `agent_id`'si)
    verilir; `agentRecord`, çağıranın cüzdanı ve bu kimlikle türetilen PDA olmalıdır.
- **Kayıt bağlantısı:** Kartın `registrations`'ı bu kaydı içermelidir: `solana:<chain-ref>:<registry>` ve
  AgentRecord adresi.
- **Saklanan baytlar:** Kartın RFC 8785 kanonik JSON'u. Dönen `agentCardHash` bu baytların SHA-256'sı,
  `agentCardUri` A2A keşif yoludur; ikisi `register_agent` / `update_agent`'ın argümanlarıdır.
- **Keşif yolu** aynı baytları zarfsız verir.
- **`cardVerified`:** Baytların hash'inin zincirdeki güncel `agentCardHash`'e eşit olmasıdır.
- **Beceri araması:** `listAgents?skill=` becerinin kimliğiyle ya da etiketiyle eşleşir.

## Politika meta verisi

Yazan, kurumun güncel yetkilisidir (program arayüzü §2):

- **Multisig bağlı değilse:** Kurum anahtarı (`owner_key`).
- **Bağlıysa:** Zincirdeki yetkili Squads vault PDA'sıdır ve mesaj imzalayamaz. Meta veriyi multisig'te öneri
  açabilen (`Initiate`) üyeler yazar; üyeler multisig hesabından o anda okunur.

İstekteki `updatedAt` sözleşmedeki şemanın alanıdır; yazma zamanı sunucunundur.

## Travel Rule

Eşiği aşan fonlamada kurum, Travel Rule kaydının salt'lı commitment'ını job'a bağlar (`commitTravelRule`,
[ADR 0015](../../docs/decisions/0015-travel-rule-commitment-ve-esik.md)). Kayıt zincire çıkmaz; API'de şifreli
saklanır ([ADR 0017](../../docs/decisions/0017-travel-rule-saklama-erisim-ve-paylasim.md)). Uçlar yalnızca cüzdan
oturumuyla çağrılır; API anahtarı kabul edilmez.

| Uç | Kim | Ne yapar |
|---|---|---|
| `PUT /v1/jobs/{job}/travel-rule` | Job'u açan kurumun güncel yetkilisi ([Politika meta verisi](#politika-meta-verisi) ile aynı kural) | Kaydı doğrular, yeni salt üretir, commitment'ı hesaplar ve şifreli saklar. Job zincirde `Open` olmalı (fonlanmış işte 409); kaydın `amount` ve `mint`'i job'unki olmalı |
| `GET /v1/jobs/{job}/travel-rule` | Kurumun yetkilisi ya da süresi dolmamış izni olan cüzdan | Kaydı ve salt'ı döner. Sunucu commitment'ı kayıttan yeniden hesaplar ve zincirdekiyle karşılaştırır (`committed`) |
| `POST /v1/jobs/{job}/travel-rule/grants`, `DELETE …/grants/{grantee}` | Kurumun yetkilisi | Karşı VASP'a ya da denetçiye süreli okuma izni verir, geri alır |
| `GET /v1/jobs/{job}/travel-rule/access` | Kurumun yetkilisi | Erişim kaydı: yazma, okuma, izin, geri alma, silme; işlemi yapan cüzdan ve istek kimliği |

- **Şifreleme:** Zarf şifrelemesi, `@squaresdk/solana-hardening`'in `SecretBox`'ı (AES-256-GCM).
  - Her kayıt kendi rastgele veri anahtarıyla şifrelenir; veri anahtarı `API_TRAVEL_RULE_KEYS` halkasındaki
    etkin ana anahtarla sarılır.
  - Ek doğrulanan veri, şifreli kaydı job'a ve commitment'a bağlar. Başka bir satıra kopyalanan veri açılmaz.
- **Anahtar döndürme:**
  1. Yeni anahtar halkaya eklenir ve `API_TRAVEL_RULE_ACTIVE_KEY_ID` yapılır.
  2. Bakım eski anahtarla sarılmış veri anahtarlarını yeniden sarar. Kayıtlar yeniden şifrelenmez.
  3. Eski anahtar, `key_id`'si onu gösteren kayıt kalmayınca halkadan çıkarılır.
- **Erişim kaydı:** Kişisel veriye dokunan her işlem, işlemle aynı transaction'da `travel_rule_accesses`'a
  yazılır. Okumada kayıt, erişim kaydı yazıldıktan sonra açılır.
- **Saklama:** Kayıt son yazmadan `API_TRAVEL_RULE_RETENTION_DAYS` gün sonra silinir. Silinenler şifreli kayıt,
  sarılmış anahtar ve anahtar kimliğidir; commitment, özet ve erişim kaydı kalır. Süre hukuki karardır ve kurulumda verilir.
- **Bakım:** Silme ve yeniden sarma her `API_TRAVEL_RULE_MAINTENANCE_INTERVAL_SECONDS`'ta bir koşar. Hatası
  `api_errors` alarmına sayılır.


## CCTP

Başka zincirde yakılan USDC ile job fonlama (BE-26, [cctp-funding.md](../../docs/design/cctp-funding.md#relayer-be-26)).
Mantık `@squaresdk/solana-cctp`'dedir; attestation'ı keeper'daki relayer izler.
- **Kayıt (`POST /v1/cctp/transfers`):** Oturum ya da `tx:prepare` kapsamlı anahtarla, job'un kurumu
  (`institution`) adına. Job `Open`, mint'i settlement mint'i olmalı; kaynak domain `API_CCTP_LOOKUP_TABLES`'ta
  olmalı. Aynı burn aynı job'a yeniden kaydedilirse aynı transfer döner (200), başka job'a 409.
- **Okuma (`GET /v1/cctp/transfers`, `GET /v1/cctp/transfers/{id}`):** Açık; mesaj ve attestation Circle'ın
  servisinde de açıktır.
- **Kurumun tx'i (`POST /v1/cctp/transfers/{id}/tx`):** Mesaj teslim edilmediyse mint ile `fund_job` tek tx'te,
  Square ALT'ı (`API_LOOKUP_TABLE`) ve kaynağın CCTP ALT'ıyla (`receiveAndFund`); edildiyse yalnızca `fund_job`
  (`fund`). Tx simüle edilir; zincirde düşecek tx 422.
- **Yapılandırma:** `API_CCTP_MESSAGE_TRANSMITTER`, `API_CCTP_TOKEN_MESSENGER_MINTER`, `API_CCTP_LOOKUP_TABLES`
  birlikte verilir; verilmezse kayıt ve tx reddedilir.
## Çalıştırma

Migration'lar ve `programs` tablosunun seed'i API'den önce uygulanır (indexer'la aynı; [apps/indexer](../indexer/README.md#çalıştırma)).
Ortam değişkenleri [`.env.example`](.env.example)'dadır; varsayılan değer yoktur. İmaj:
`docker build -f apps/api/Dockerfile .` (repo kökünden).

| Uç | Port |
|---|---|
| `/v1/*`, `/a/*`, `GET /openapi.json`, `/health`, `/ready` (veritabanı, RPC, depo) | `API_PORT` |
| `GET /metrics` | `API_METRICS_PORT` (iç ağ) |

**Alarm:** `api_errors`: iç hatalar ve bağımlılık hataları (RPC, prover, depo, veritabanı) pencerede eşiğin
üstünde.

## Testler

`pnpm --filter @squaresdk/solana-api test`. Testler Postgres ve S3 uyumlu depo (SeaweedFS) konteynerleri açar
(Docker gerekir). Zincir ve prover yerel fixture sunucularıdır. Uçlar SDK'nın `createApiClient`'ıyla denenir.
Sözleşmedeki 33 operasyonun hepsi ve yetkisiz erişim yolları test edilir. Gerçek programlarla uçtan uca
deneme BE-36'dadır.

## Kaynak

Covenant `app/app/api/{jobs,escrow,claims,disputes,agents,auth,keys,openapi}` ve `app/lib/{wallet-auth,session,api-response}.ts`
LGPL-2.1 `app/` dizinindedir ve Square'e taşınmaz ([BC-03 kaydı](../../docs/legal/relicensing/README.md)).
Teslimatın depoya yüklenip herkese açık adresin `deliveryUri` olması Covenant'ın akışıdır; kod sıfırdan yazıldı.
AIP `src/lib/auth/wallet-auth.ts` yalnızca kapsam için okundu. Orada imza `AIP-AUTH:<cüzdan>:<zaman>` metni üzerindeydi ve 24 saat boyunca her istekte yeniden kullanılıyordu; nonce ve alan adı yoktu. Burada tek kullanımlık nonce'lu, alan adlı mesaj bir kez imzalanır, istekler süreli ve iptal edilebilir oturum belirteciyle gelir.
