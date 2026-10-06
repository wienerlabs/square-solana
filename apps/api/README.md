# @squaresdk/solana-api

Square'in REST API servisi (BE-18, uyuşmazlık araçları BE-22). Sözleşme
[`docs/api/openapi.yaml`](../../docs/api/openapi.yaml)'dır (36 operasyon); servis `GET /openapi.json`'da sözleşmenin derlenmiş halini yayımlar. Web uygulaması ve
entegrasyonlar SDK'nın `createApiClient`'ıyla bağlanır.

| Etiket | Uygulama |
|---|---|
| auth | Cüzdan Ed25519 oturumu ve API anahtarları ([Kimlik](#kimlik)) |
| okuma | Job, kurum, politika, agent, alacak, dispute, screening ve event görünümleri indexer'ın tablolarından (`@squaresdk/solana-indexer/read`); keeper günlüğü `keeper_actions`'tan |
| tx | 8 adımın imzasız v0 tx'i ([Tx hazırlama](#tx-hazırlama)) |
| teslimat | Dosya S3 uyumlu depoya yüklenir; `submit_work`'ün `workHash` ve `deliveryUri`'si döner ([Teslimat](#teslimat)) |
| agent card | Barındırma ve A2A keşif yolu `/a/{agentRecord}/.well-known/agent-card.json` ([Agent card](#agent-card)) |
| politika meta | Herkese açık ad, açıklama ve etiketler; yazan kurumun güncel yetkilisi |
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
  `prove`, `disputes:write`.
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
    (`whsec_…`) yalnızca bu yanıtta döner. Veritabanında secret box'la (`API_SECRET_BOX_*`, AAD kaydın
    kimliği) şifreli durur.
  - Olaylar:
    - `dispute.raised`, `dispute.escalated`, `dispute.vote` (oyu verene gitmez), `dispute.decided`: indexer'ın
      `chain_events`'inden.
    - `dispute.deadline`: son tarihe `API_NOTIFY_DEADLINE_WARNING_SECONDS` kala, oy vermemiş arbitrator'lara bir
      kez.
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
Sözleşmedeki 36 operasyonun hepsi ve yetkisiz erişim yolları test edilir. Bildirim outbox'ı yerel bir alıcıya
imzalı teslimle denenir (`test/notifier.test.ts`).

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

Agave 4.1.2 ve `anchor build` çıktısı gerekir; senaryo yaklaşık iki dakika sürer. Devnet'te deneme yapılmadı
(devnet dağıtımı BC-30).

## Kaynak

Covenant `app/app/api/{jobs,escrow,claims,disputes,agents,auth,keys,openapi}` ve `app/lib/{wallet-auth,session,api-response}.ts`
LGPL-2.1 `app/` dizinindedir ve Square'e taşınmaz ([BC-03 kaydı](../../docs/legal/relicensing/README.md)).
Teslimatın depoya yüklenip herkese açık adresin `deliveryUri` olması Covenant'ın akışıdır; kod sıfırdan yazıldı.
AIP `src/lib/auth/wallet-auth.ts` yalnızca kapsam için okundu. Orada imza `AIP-AUTH:<cüzdan>:<zaman>` metni üzerindeydi ve 24 saat boyunca her istekte yeniden kullanılıyordu; nonce ve alan adı yoktu. Burada tek kullanımlık nonce'lu, alan adlı mesaj bir kez imzalanır, istekler süreli ve iptal edilebilir oturum belirteciyle gelir.
