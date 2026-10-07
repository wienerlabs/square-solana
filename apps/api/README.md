# @squaresdk/solana-api

Square'in REST API servisi (BE-18; Travel Rule kaydı BE-23, uyuşmazlık araçları BE-22, x402 uç nokta tanımları FE-22, Stripe MPP fiat ödemesi BE-25). Sözleşme
[`docs/api/openapi.yaml`](../../docs/api/openapi.yaml)'dır (60 operasyon); servis `GET /openapi.json`'da sözleşmenin derlenmiş halini yayımlar. Web uygulaması ve
entegrasyonlar SDK'nın `createApiClient`'ıyla bağlanır.

| Etiket | Uygulama |
|---|---|
| auth | Cüzdan Ed25519 oturumu ve API anahtarları ([Kimlik](#kimlik)) |
| x402 | Geliştiricinin ücretli uç nokta tanımları ve kullanımı ([x402 ücretli uç noktalar](#x402-ücretli-uç-noktalar)) |
| okuma | Job, kurum, politika, agent, alacak, dispute, screening ve event görünümleri indexer'ın tablolarından (`@squaresdk/solana-indexer/read`); keeper günlüğü `keeper_actions`'tan |
| tx | 8 adımın imzasız v0 tx'i ([Tx hazırlama](#tx-hazırlama)) |
| teslimat | Dosya S3 uyumlu depoya yüklenir; `submit_work`'ün `workHash` ve `deliveryUri`'si döner ([Teslimat](#teslimat)) |
| agent card | Barındırma ve A2A keşif yolu `/a/{agentRecord}/.well-known/agent-card.json` ([Agent card](#agent-card)) |
| politika meta | Herkese açık ad, açıklama ve etiketler; yazan kurumun güncel yetkilisi |
| travel rule | Kaydın şifreli saklanması, commitment'ı, izinli okuma ve erişim kaydı ([Travel Rule](#travel-rule)) |
| cctp | Burn'ün job'a kaydı, transferin durumu, kurumun mint + fonlama tx'i ([CCTP](#cctp)) |
| fiat | Fiat işin Stripe ödemesi (tarayıcı, kayıtlı kart, MPP), imzalı webhook, makbuz ve MPP attestation'ı ([Fiat ödeme](#fiat-ödeme)) |
| prover | `POST /v1/prove`, prover servisine (apps/prover) vekil |
| uyuşmazlık | Dispute kanıtı (özel depo), arbitrator kuyruğu, ön denetimli oy tx'i, arbitrator webhook bildirimleri ([Uyuşmazlık](#uyuşmazlık)) |

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
  `prove`, `disputes:write`, `x402:serve`.
  - Anahtar `sqk_` + 32 rastgele bayttır ve yalnızca oluşturma yanıtında bir kez döner.
  - Listelemede ilk 12 karakteri (`prefix`) görünür.
  - Anahtar `X-API-Key` başlığıyla gönderilir. İki başlık birlikte gönderilemez.
- **Uçların yetkisi** (OpenAPI `security`):

  | Uçlar | Yetki |
  |---|---|
  | Anahtar yönetimi, oturum kapatma, politika meta | Oturum |
  | `uploadDelivery`, `putAgentCard`, `prepareTx` | Oturum ya da kapsamlı anahtar |
  | `prove` | Yalnızca `prove` kapsamlı anahtar |
  | `uploadDisputeEvidence` (`disputes:write`), `prepareDisputeVote` (`tx:prepare`), `listDisputeEvidence`, `getDisputeEvidenceContent`, `getArbitrationQueue` (`read`) | Oturum ya da kapsamlı anahtar; kaynak üzerindeki yetki [Uyuşmazlık](#uyuşmazlık)'ta |
  | Webhook abonelikleri | Oturum; yalnızca aktif arbitrator |
  | `createX402Endpoint`, `updateX402Endpoint`, `deleteX402Endpoint` | Oturum |
  | `listX402Endpoints`, `getX402Endpoint`, `getX402EndpointUsage`, `recordX402Payment` | Oturum ya da `x402:serve` kapsamlı anahtar |
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

## Uyuşmazlık

M-of-N arbitration ve dispute zaman aşımının zincir dışı tarafı (BE-22; zincir kuralları
[ADR 0016](../../docs/decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md)). Son tarihi geçen
dispute'u keeper'ın lapse crank'i düşürür ([apps/keeper](../keeper/README.md)).

- **Taraflar:**
  - Kurum: job'un `institution` cüzdanı. Job kurumun Squads vault'una aitse multisig'in `Initiate` yetkili
    üyeleri.
  - Agent: job'un agent cüzdanı ya da agent kaydının sahibi.
  - Arbitrator: zincirdeki `EscrowConfig`'in aktif seti. SDK ile okunur, `API_ARBITRATOR_CACHE_SECONDS` boyunca
    önbellekte durur.
- **Kanıt (`reason_hash` ↔ zincir dışı kanıt):**
  - `POST /v1/jobs/{job}/dispute/evidence` (multipart, `file` alanı). Dönen `reasonHash` içeriğin SHA-256'sıdır.
  - Kurum kanıtı `raise_dispute`'tan önce yükler (job `delivered`) ve bu hash'i argüman olarak verir. Agent ve
    arbitrator'lar dispute açıldıktan sonra (`disputed`, `resolved`) ekler.
  - İçerik `API_EVIDENCE_S3_BUCKET` kovasında `<job>/<hash>` anahtarıyla durur. Kova teslimat kovasından ayrıdır
    ve herkese açık okunmaz: hash zincirde açık olduğundan adres içeriği gizlemez.
  - `GET /v1/disputes/{job}/evidence` listeler. `isDisputeReason`, zincirdeki dispute'un `reasonHash`'ine eşitliktir.
    `GET /v1/disputes/{job}/evidence/{id}` baytları ek olarak (`content-disposition: attachment`) verir. Okuyan
    yine üç taraftır.
  - Aynı içerik ikinci kez yüklenirse ilk kayıt döner (`(job, hash)` tekil); istek doğal olarak idempotenttir.
- **Kuyruk:** `GET /v1/arbitration/queue`, yalnızca aktif arbitrator içindir. Açık (`disputed`) dispute'lar
  son tarihi en yakın önce gelir.
  - Oylar `DisputeVote` event'lerindendir (dispute'un son açılışından sonra).
  - `hasVoted`, aynadaki `approval_mask` ve set sürümünden gelir. Sürüm config'tekinden eskiyse sonraki oy
    sayımı sıfırlar; arbitrator oy vermemiş sayılır.
  - `canVote`: oy yok ve son tarih geçmedi.
- **Oy:** `POST /v1/disputes/{job}/votes` → `resolve_dispute` için imzasız tx (genel tx hazırlayıcıyla, simüle
  edilmiş). Ön denetim zincirdeki job ve config'le yapılır:
  - aktif arbitrator değil → 403;
  - dispute açık değil ya da son tarih geçti → 409;
  - güncel sayımda oy verdi ya da oy ilk oyun kararından farklı → 409;
  - `pending` oy ya da escrow'u aşan `split` → 400.

  Fee payer verilmezse arbitrator'ın kendisidir. Kesin kural programdadır; zincirde düşecek tx 422 alır.
- **Bildirim:**
  - Arbitrator `POST /v1/arbitration/webhooks` ile https uç kaydeder (oturum, en çok 10). Standard Webhooks sırrı
    (`whsec_…`) yalnızca bu yanıtta döner. Veritabanında secret box'la (`API_WEBHOOK_SECRET_KEYS`, AAD kaydın
    kimliği) şifreli durur.
  - Olaylar:
    - `dispute.raised`, `dispute.escalated`, `dispute.vote` (oyu verene gitmez), `dispute.decided`: indexer'ın
      `chain_events`'inden.
    - `dispute.deadline`: son tarihe `API_NOTIFY_DEADLINE_WARNING_SECONDS` kala, oy vermemiş arbitrator'lara bir
      kez. Bir tur en çok `API_NOTIFY_BATCH_SIZE` dispute için uyarı kuyruğa alır; kuyruğa girmiş uyarılar atlanır,
      kalanlar sonraki turlarda son tarih sırasıyla alınır.
  - Outbox: olay uç başına bir kez kuyruğa girer (`notification_outbox`, `(uç, olay)` tekil). API süreci her
    `API_NOTIFY_INTERVAL_MS`'te kuyruğu işler.
    - Satır kiralanır; birden çok API örneği aynı satırı göndermez.
    - Gövde imzalı, SSRF korumalı istemciyle gider (yönlendirme izlenmez). Teslimat kimliği (`webhook-id`)
      denemeler arasında değişmez.
    - 2xx dışı yanıt ve hata üstel geri çekilmeyle yeniden denenir. `API_NOTIFY_MAX_ATTEMPTS`'ta `failed` olur.
    - Arbitrator setten çıktıysa teslim edilmez.
  - Metrik: `api_arbitration_notifications_total{result}`.
  - İmleç yoksa en son event'ten başlanır: geçmiş event'ler bildirilmez. Gövde şeması OpenAPI
    `webhooks.arbitrationNotification`'dadır. Alıcı `verifyWebhook` ile doğrular (`@squaresdk/solana-hardening`).

## x402 ücretli uç noktalar

Geliştirici portalının (FE-22, web `/app/developers`) arka ucu. Karar:
[ADR 0023](../../docs/decisions/0023-x402-ucretli-uc-nokta-tanimlari.md).

- **Tanım** (`x402_endpoints`) cüzdana aittir:
  - ad, yol (geliştiricinin sunucusundaki route; cüzdan başına tekil, 409);
  - fiyat (`amount`, mint'in taban biriminde, > 0), mint ve ağ (CAIP-2);
  - alıcı (`payTo`), açıklama, etkin / pasif.
- **Ödeme** geliştiricinin sunucusunda istenir: `@squaresdk/solana-x402` `paidRouteFromDefinition` tanımı
  `getX402Endpoint` ile okur. Facilitator ve ücret ödeyen cüzdan o sunucudadır; API ödeme yolunda değildir.
- **Bildirim** (`recordX402Payment`, `x402_payments`): sunucu uzlaştırdığı her ödemeyi bildirir.
  - `fingerprint` ödeme yükünün tekrar koruması kimliği, `transaction` makbuzun işlem imzasıdır. İkisi de ağ
    başına tekildir.
  - Aynı bildirimin tekrarı ilk kaydı 200 ile döner; başka tanıma ya da farklı işlemle bildirim 409 alır.
  - Ağ, mint ve alıcı tanımınkiyle aynı olmalıdır (400, `details.fields`). Tutar bildirildiği gibi kaydedilir.
- **Kullanım** (`getX402EndpointUsage`): ödemeli çağrı sayısı, ağ ve mint başına toplam, son ödeme zamanı, son
  20 ödeme. Tanım silinince kullanım kaydı da silinir.

## Fiat ödeme

Stripe MPP fiat rayının ödeme tarafı (BE-25). Karar: [ADR 0026](../../docs/decisions/0026-stripe-mpp-fiat-odemesi.md);
zincir tarafı [ADR 0024](../../docs/decisions/0024-stripe-mpp-fiat-rayi.md). Kod `src/fiat/` ve `src/routes/fiat.ts`.

- **Hesap:** Ödeme Square'in Stripe hesabına yapılır, USD'dir. Tutar işin tutarıdır; settlement mint'inin taban
  biriminden sente çevrilir (1 sent = 10^(decimals − 2)). Tam sent olmayan ya da 50 sentin altındaki iş ödenmez.
- **Ön koşul (her yol):**
  - job fiat rayında ve `Delivered`;
  - çağıran job'un kurumunun güncel yetkilisi;
  - işin attestation'ı yok (409);
  - ödeme kurumun public günlük tavanını bugünkü sayaçla aşmıyor (400, `details.dailyCeiling`).
- **Yollar:**
  - `createFiatPayment` `offSession: false`: tarayıcıda Stripe.js ile onaylanacak PaymentIntent; işin açık
    PaymentIntent'i yeniden kullanılır.
  - `createFiatPayment` `offSession: true`: kurumun kayıtlı kartıyla hemen öder, attestation yanıttadır. Red ya da
    müşterinin onayı gerekirse 402 `payment_failed`.
  - `payFiatJobMpp`: MPP 402 akışı (`mppx` Stripe `charge`, Shared Payment Token). Kimlik yalnızca `fiat:pay`
    kapsamlı `X-API-Key`'dir; `Authorization` MPP credential'ını taşır. İstemci `mppx/client`'ın `fetch`'ini
    `createApiClient({ fetch })`'e verir.
- **Kart:** `createFiatSetupIntent` (off-session SetupIntent); kart `setup_intent.succeeded` webhook'uyla kaydedilir,
  öncekinin yerini alır. `getFiatCustomer` kartın markasını ve son dört hanesini döner.
- **Attestation:** Makbuz PaymentIntent Stripe'tan yeniden okunarak kurulur. Poseidon commitment'ı ve ADR 0024
  mesajının MPP authority imzası `mpp_payments`'a yazılır. Üç kaynak:
  - imzalı webhook (`POST /v1/stripe/webhook`, `Stripe-Signature`, 300 saniye tolerans);
  - kurumun mutabakat isteği (`reconcileFiatPayment`);
  - MPP isteğinin kendisi.

  Aynı olay ya da ödeme kaydı değiştirmez. Attestation'ı olan işe gelen ikinci başarılı ödeme iade edilir.
  İmzalayan anahtar değişmişse (rotasyon) attestation okunurken yeniden imzalanır.
- **Webhook ve MPP** genel kimlik ara katmanından ve `express.json`'dan önce bağlanır: imza ham gövde üzerindedir.
- **Yapılandırma:**
  - Dört değişken birlikte verilir; verilmezse fiat uçları 503 `payment_unavailable` döner: `API_STRIPE_SECRET_KEY`,
    `API_STRIPE_PUBLISHABLE_KEY`, `API_STRIPE_WEBHOOK_SECRET`, `API_MPP_AUTHORITY_KEYPAIR`.
  - MPP için `API_MPP_SECRET_KEY` ve `API_MPP_NETWORK_ID` (Stripe profili) birlikte verilir; yoksa yalnızca MPP
    ucu 503 döner.

  Stripe panelinde webhook ucu `<API_PUBLIC_BASE_URL>/v1/stripe/webhook`, olaylar `payment_intent.succeeded` ve
  `setup_intent.succeeded`.
- **Kurum tarafı:** Attestation ispatla `@squaresdk/solana-policy` `buildVerifyMppPaymentProofTx`'e verilir; iş
  `finalize_fiat_payment` ile kapanır. `watchJobProof` (`mppAttestation`) bayatlayan ispatı yeniler.

## Çalıştırma

Migration'lar ve `programs` tablosunun seed'i API'den önce uygulanır (indexer'la aynı; [apps/indexer](../indexer/README.md#çalıştırma)).
Ortam değişkenleri [`.env.example`](.env.example)'dadır; varsayılan değer yoktur. İmaj:
`docker build -f apps/api/Dockerfile .` (repo kökünden).

| Uç | Port |
|---|---|
| `/v1/*`, `/a/*`, `GET /openapi.json`, `/health`, `/ready` (veritabanı, RPC, teslimat ve kanıt depoları) | `API_PORT` |
| `GET /metrics` | `API_METRICS_PORT` (iç ağ) |

**Alarm:** `api_errors`: iç hatalar ve bağımlılık hataları (RPC, prover, depo, veritabanı) pencerede eşiğin
üstünde.

## Testler

`pnpm --filter @squaresdk/solana-api test`. Testler Postgres ve S3 uyumlu depo (SeaweedFS) konteynerleri açar
(Docker gerekir). Zincir ve prover yerel fixture sunucularıdır. Uçlar SDK'nın `createApiClient`'ıyla denenir.
Sözleşmedeki 60 operasyonun hepsi ve yetkisiz erişim yolları test edilir. Bildirim outbox'ı yerel bir alıcıya
imzalı teslimle denenir (`test/notifier.test.ts`).

**x402 kabulü (FE-22):** `test/x402.test.ts` ücretli uç nokta yönetimini uçtan uca dener:

1. Oturumla tanım oluşturulur.
2. Geliştiricinin sunucusu (`paidRouteFromDefinition`, kendi facilitator'ı, `x402:serve` anahtarı) ödemesiz
   isteğe 402 döner.
3. `createPayingFetch` ile ödeme yapılır: resmi exact şeması, x402 paketinin test fikstürü olan Solana JSON-RPC'si (`packages/x402/test/solana-rpc.ts`).
   İstek 200 alır.
4. Kullanım sayacı ve tahsil edilen tutar artar.
5. Pasifleştirilen tanım 503, silinen tanım 404 alır.

**Localnet uçtan uca (BE-22):** `test/localnet.e2e.test.ts`, `SQUARE_LOCALNET=1` ile çalışır (yoksa atlanır).
Gerçek programları `solana-test-validator`'a yükler; indexer ve keeper'ı gerçek süreç olarak açar. İki senaryo
koşar:

- kanıt → `raise_dispute` → kuyruk → API'nin hazırladığı iki oy → `execute_resolution`;
- `raise_dispute` → son tarih → keeper'ın `lapse_dispute`'u.

```bash
pnpm turbo build --filter @squaresdk/solana-api...
SQUARE_LOCALNET=1 SQUARE_PROGRAMS_DIR=<repo>/target/deploy SQUARE_LOCALNET_RPC_PORT=8899 \
  SQUARE_LOCALNET_ARGS="--faucet-port 9900" pnpm --filter @squaresdk/solana-api exec vitest run test/localnet.e2e.test.ts
```

Agave 4.1.2 ve `anchor build` çıktısı gerekir; senaryo yaklaşık iki dakika sürer.

**Arayüzden uçtan uca (FE-17):** `test/web-dispute.e2e.test.ts`, `SQUARE_LOCALNET=1` ve `SQUARE_WEB_E2E=1` ile çalışır.
- **Kurulum:** Localnet dünyası `test/fixtures/localnet.ts`'tir (BE-22 testiyle ortak). Web derlenmiş hâliyle ayrı
  süreçte açılır; API'nin CORS'u ve giriş mesajının alanı web'in adresidir.
- **Tarayıcı:** Playwright. Her rolün bağlamına bir Wallet Standard cüzdanı eklenir (`test/fixtures/standard-wallet.js`);
  imzalar test sürecinde rolün anahtarıyla atılır.
- **Senaryo:** Kurum iş sayfasında API'ye girer, kanıt dosyasını seçer, itiraz eder. İki arbitrator `/app/arbitration`'da
  oy verir. Karar iş sayfasından ödenir. İkinci işte son tarih geçince sayfa "Can be lapsed" der ve sayfadan lapse
  edilir.

```bash
pnpm turbo build --filter @squaresdk/solana-api... --filter @squaresdk/solana-web
SQUARE_LOCALNET=1 SQUARE_WEB_E2E=1 SQUARE_WEB_E2E_CHANNEL=chrome SQUARE_LOCALNET_RPC_PORT=8899 \
  pnpm --filter @squaresdk/solana-api exec vitest run test/web-dispute.e2e.test.ts
```

**Devnet uçtan uca (BE-22):** `test/devnet.e2e.test.ts` yalnızca ortamla çalışır; anahtarlar repoda tutulmaz.
- **Ne kullanır:** Devnet'teki programlar ve escrow config'i. Indexer gerçek süreç olarak devnet'i indexler.
- **Senaryo:** kanıt → `raise_dispute` → kuyruk → iki arbitrator'ın API'den aldığı oy tx'leri → üçüncü oyun reddi →
  `execute_resolution`.
- **Lapse:** Devnet'te dispute son tarihi 7 gündür; lapse senaryosu localnet testindedir.

```bash
pnpm turbo build --filter @squaresdk/solana-api... --filter @squaresdk/solana-indexer
DISPUTE_E2E_INSTITUTION=<kurum keypair'i> DISPUTE_E2E_AGENT=<agent cüzdanı keypair'i> \
DISPUTE_E2E_AGENT_RECORD=<agent kaydı> DISPUTE_E2E_ARBITRATORS=<üç arbitrator keypair'i, virgülle> \
  pnpm --filter @squaresdk/solana-api exec vitest run test/devnet.e2e.test.ts
```

Koşu kaydı: [deploy kaydı](../../docs/deploy/devnet.md#uyuşmazlık-be-22).

**Devnet: geliştirici portalı (FE-22):** `test/x402-devnet.e2e.test.ts` yalnızca ortamla çalışır.
- **Akış:** API anahtarı portalın uçlarıyla oluşturulur → ücretli uç nokta tanımı → geliştiricinin sunucusu
  (`paidRouteFromDefinition`) gerçek devnet USDC'siyle ödeme alır → kullanım → pasifleştirme ve silme → anahtar
  iptali.
- **Ortam:** `X402_PORTAL_E2E_DEVELOPER`, `X402_PORTAL_E2E_PAYER`, `X402_PORTAL_E2E_FEE_PAYER`, `X402_PORTAL_E2E_PAY_TO`.
- **Kayıt:** [deploy kaydı](../../docs/deploy/devnet.md#geliştirici-portalı-fe-22).

**Devnet + Stripe test modu: fiat ödeme (BE-25):** `test/fiat-devnet.e2e.test.ts` yalnızca `FIAT_E2E_*` ortamıyla
çalışır. Akış: fiat iş → PaymentIntent → test kartıyla onay → mutabakat → attestation → ispat (makbuz commitment'ı) →
`verify_mpp_payment_proof` → `finalize_fiat_payment`. `FIAT_E2E_NETWORK_ID` (Stripe profili) verilirse ikinci iş
MPP'yle ödenir. Koşu kaydı: [fiat-devnet.md](../../docs/deploy/fiat-devnet.md).

## Kaynak

Covenant `app/app/api/{jobs,escrow,claims,disputes,agents,auth,keys,openapi}` ve `app/lib/{wallet-auth,session,api-response}.ts`
LGPL-2.1 `app/` dizinindedir ve Square'e taşınmaz ([BC-03 kaydı](../../docs/legal/relicensing/README.md)).
Teslimatın depoya yüklenip herkese açık adresin `deliveryUri` olması Covenant'ın akışıdır; kod sıfırdan yazıldı.
AIP `src/lib/auth/wallet-auth.ts` yalnızca kapsam için okundu. Orada imza `AIP-AUTH:<cüzdan>:<zaman>` metni üzerindeydi ve 24 saat boyunca her istekte yeniden kullanılıyordu; nonce ve alan adı yoktu. Burada tek kullanımlık nonce'lu, alan adlı mesaj bir kez imzalanır, istekler süreli ve iptal edilebilir oturum belirteciyle gelir.
