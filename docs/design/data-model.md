# Veri modeli: tek Postgres veritabanı

**Issue:** BE-04 (#18) · **Karar:** [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar),
tek Postgres + Prisma · **Şema:** [`db/prisma/schema.prisma`](../../db/prisma/schema.prisma) ·
**Paket:** `@squaresdk/solana-db` ([`db/`](../../db/))

Kaynak projelerde dört ayrı veritabanı kurulumu vardı: Covenant'ta Neon + Prisma, Aperture'da iki
servis ham `pg` ile, AIP'de Supabase. Square bunların yerine tek bir Postgres veritabanı ve tek bir
Prisma şeması kullanır. Bütün servisler (API, indexer, keeper, screener, ödeme rayları) aynı
`@squaresdk/solana-db` istemcisini kullanır.

## 1. İlke: zincir kaynak-gerçektir

On-chain durumun tek doğruluk kaynağı Solana'dır. Veritabanı bu durumun bir **indeksi ve
önbelleğidir**. Zincire çıkmayan veriyi de tutar.

| Kural | Uygulama |
|---|---|
| Program hesaplarının tabloları (**ayna tablolar**) zincirden türetilir | Ayna tablolara yalnızca indexer (BE-14) yazar. Yazdığı değer bir hesap ya da event'ten gelir. Başka servis ayna tabloya yazmaz. |
| Ayna tablolar yeniden üretilebilir | Ayna tablolar boşaltılıp `indexer_cursors` silinirse indexer aynı durumu zincirden yeniden kurar. Zincir dışı tablolar bundan etkilenmez. |
| Yalnızca kesinleşmiş veri | `chain_events` ve ayna tablolar `finalized` commitment'tan beslenir. Böylece fork geri alımı gerekmez. |
| Hesabın kendisi aynen saklanır | `account` sütunu hesabın IDL JSON kodlamasıdır ([api-sdk-contract.md §3](api-sdk-contract.md#3-json-kodlaması)). API görünümleri bunu `account` alanında aynen döner. Filtre sütunları ondan çıkarılır, ayrı bir değer taşımaz. |
| Tazelik görünür | Her ayna satırında `slot` (hesabı son değiştiren slot) ve `indexed_at` bulunur. Bunlar görünümlerdeki `slot` / `indexedAt` alanlarıdır. |
| Karar zincirde verilir | Keeper, API ve ödeme rayları bir işlemin yapılıp yapılamayacağına veritabanına bakarak karar vermez. Veritabanı yalnızca adayları bulur; asıl kontrol zincirde, tx'in kendisinde yapılır. |

Veritabanında **asla** tutulmayanlar:

- Politika kuralları ve salt: zincirde yalnızca commitment vardır; `policy_metas` yalnızca herkese açık meta veriyi tutar.
- Travel Rule verisinin düz metni: yalnızca zarf şifrelemeli hâli tutulur.
- Oturum belirteçleri ve API anahtarlarının gizli değerleri: yalnızca SHA-256'ları tutulur.
- Özel anahtarlar.

## 2. Tablolar

### Ayna tablolar (indexer yazar)

| Tablo | Kaynak hesap | Filtre sütunları | API |
|---|---|---|---|
| `institutions` | policy `Institution` | `owner_key`, `multisig_vault` | `getInstitution` |
| `policies` | policy `Policy` | `institution`, `policy_id`, `version`, `active` | `listPolicies`, `getPolicy` |
| `agents` | registry `AgentRecord` | `creator` + `agent_id` (tekil), `owner`, `wallet`, `status` | `listAgents`, `getAgent` |
| `screenings` | registry `ScreeningRecord` | `wallet` (tekil), `status`, `expires_at` | `getScreening` |
| `jobs` | escrow `Job` | `status`, `institution`, `agent_record`, `agent_wallet`, `policy`, `challenge_end` | `listJobs`, `getJob` |
| `disputes` | escrow `Job.dispute` izdüşümü | `job_status`, `raised_at`, `institution`, `agent_record` | `listDisputes`, `getDispute` |
| `claims` | escrow `ClaimListing` | `job` (tekil), `status`, `seller`, `buyer` | `listClaims`, `getClaim`, `JobView.claim` |
| `agent_reputations` | escrow `AgentReputation` | `agent_record` (tekil), `jobs_completed` | `AgentView.reputation` |
| `validation_records` | escrow `ValidationRecord` | `job` (tekil), `agent_record` | `JobView.validation` |
| `release_proofs` | verifier `ReleaseProof` | `job` (tekil), `institution`, `consumed` | `JobView.releaseProof` |
| `chain_events` | ham program event'leri | `(signature, instruction_index, event_index)` tekil; `slot`, `program` + `name`, `job` | `listEvents` |
| `indexer_cursors` | indexer'ın program başına kaldığı yer | — | — |

Notlar:

- **Dispute** ayrı bir hesap değildir, `Job` hesabının bir alanıdır. Program kuralına göre job başına en fazla bir dispute açılabilir. `disputes` tablosu yalnızca `/v1/disputes` filtresi içindir; hesap verisi `jobs.account` içinde kalır.
- **Kapanan hesaplar:** Kapanabilen hesaplarda (`jobs`, `claims`) `closed_slot` sütunu var. Bir `ClaimListing` iptal edilip aynı PDA'da yeniden açılabilir; satır yeniden açılınca güncellenir.
- **Slot ve zaman:** `slot` hesabın okunduğu slot'tur; satır yalnızca daha yeni bir okumayla güncellenir.
  `indexed_at` indexer'ın yazma zamanıdır, API'de Unix saniyesi olarak döner. Yazma, idempotency,
  uzlaştırma ve okuma API'si: [`apps/indexer`](../../apps/indexer/README.md) (BE-14).
- **Aynalanmayan hesaplar:** Singleton config hesapları (`RegistryConfig`, `EscrowConfig`, `VerifierConfig`) ve `OperatorState` aynalanmaz; API'de görünümleri yok, okuyan servis zincirden okur. Gerekirse sonraki bir migration ile eklenir.

### Zincir dışı tablolar

| Tablo | İçerik | Yazan | Issue |
|---|---|---|---|
| `programs` | Hangi program kimlikleriyle indexlendiği + IDL sürümü (seed) | seed | BE-04 |
| `policy_metas` | Politikanın herkese açık adı, açıklaması, etiketleri | API (`putPolicyMeta`) | BE-18 |
| `agent_cards` | Barındırılan ya da indirilen agent card: ham baytlar, SHA-256, ayrıştırılmış JSON, yetenekler, zincirdeki hash ile eşleşme | API (`putAgentCard`), indexer | BE-18, BE-09 |
| `deliveries` | Teslimat içeriğinin nesne deposundaki konumu ve `submit_work`'e giden hash / URI | API (`uploadDelivery`) | BE-18 |
| `keeper_actions` | Keeper günlüğü (`KeeperAction`) | keeper | BE-15 |
| `users`, `auth_challenges`, `sessions`, `api_keys` | Cüzdan Ed25519 oturumu ve API anahtarları | API | BE-18 |
| `mpp_payments` | İmzası doğrulanmış Stripe webhook'undan gelen fiat ödemesi; makbuzun Poseidon commitment'ı ve MPP authority imzası | MPP rayı | BE-25 |
| `cctp_transfers` | CCTP mesajı (kaynak domain + nonce), Circle attestation'ı, Solana'da receive ve fund imzaları | CCTP relayer | BE-26 |
| `travel_rule_records` | Şifreli Travel Rule verisi; zincirdeki commitment ile bağlı | API | BE-23 |
| `rate_limit_windows` | Hız sınırı sayacı: anahtar (ör. `api:<cüzdan>`), pencerenin başı, ağırlık toplamı | servisler (`@squaresdk/solana-hardening/prisma`) | BE-13 |
| `idempotency_records` | `Idempotency-Key` kaydı: `(scope, key)` tekil, isteğin SHA-256'sı, durum (`in_progress` / `completed`), kaydedilen yanıtın durum kodu ve gövdesi | servisler | BE-13 |
| `replay_guards` | Tek kullanımlık kimlikler: webhook teslimat kimliği, imzalı eylem nonce'u; `(scope, id)` tekil | servisler | BE-13 |
| `a2a_tasks` | A2A görevi: agent, çağıran, bağlı job ve spec hash'i (görevin A2A bağlamı job adresidir), görev durumu, durum mesajı, artefaktlar, iyimser `version`. `job_status` ve `job_slot` sunucunun zincirde son gördüğü değerlerdir, ayna veri değildir. `(agent_record, caller, create_message_id)` tekil; kısmi tekil indeks job başına tek terminal olmayan görev | agent'ın A2A sunucusu ([a2a.md](a2a.md) §7) | BE-17 |
| `a2a_messages` | Görev geçmişi: istemci ve agent mesajları, ekleme sırasıyla; `pending` istemcinin devam mesajı agent'a iletilip işlenene kadar true. `(task_id, message_id)` tekil, görev silinince silinir | agent'ın A2A sunucusu | BE-17 |

A2A tablolarındaki mesaj ve artefakt içerikleri JSONB olarak düz metindir. Travel Rule ya da kişisel veri bu tablolara yazılmamalıdır; bunu agent kodu sağlar, depo zorlamaz. Saklama ve silme kuralı henüz yoktur ([a2a.md](a2a.md) §10).

API'nin yazdığı tablolar (BE-18, [apps/api](../../apps/api/README.md)):

- **`deliveries`:** `storage_key` içeriğin SHA-256'sıdır (S3 uyumlu deponun anahtarı). `delivery_uri` deponun herkese açık adresidir.
- **`agent_cards`:** Barındırılan kartta `raw` kartın RFC 8785 kanonik JSON'u, `skills` beceri kimlikleri ve etiketleridir. `verified` yazma anındaki eşleşmedir; görünümdeki `cardVerified` zincirdeki güncel hash'le hesaplanır.
- **`sessions`, `api_keys`:** Belirteç `sqs_…`, anahtar `sqk_…`; yalnızca SHA-256'ları durur.

Koruma tablolarının (`rate_limit_windows`, `idempotency_records`, `replay_guards`) her satırı `expires_at` taşır; süresi dolan satırı depo yeniden kullanır, `purgeExpired` siler. Kayıtlı yanıt gövdesi API yanıtıdır; gizli veri taşıyan bir uç idempotency'yi kullanmamalı ya da gövdeyi kaydetmemelidir.

Agent card kayıttan önce yüklenebilir: 8 adımın 2.sinde önce `putAgentCard`, sonra `registerAgent` gelir. Bu yüzden zincir dışı tablolardan ayna tablolara yabancı anahtar yoktur.

## 3. Kodlama

| Değer | Sütun tipi | Not |
|---|---|---|
| Adres (base58) | `VARCHAR(44)` | CHECK: base58, 32–44 karakter |
| Tx imzası (base58) | `VARCHAR(88)` | CHECK: base58, 64–88 karakter |
| 32 bayt hash / commitment | `CHAR(64)` | Küçük harf hex; CHECK |
| `u64` | `NUMERIC(20, 0)` | CHECK: `0 … 2^64−1`. Prisma `Decimal` döner, API'de ondalık string |
| Zincirden gelen zaman (`i64` unix saniyesi) | `BIGINT` | Sözleşmedeki değerin kendisi |
| Veritabanının kendi zamanları | `TIMESTAMPTZ(3)` | `indexed_at`, `created_at`, `updated_at` … |
| Enum | Postgres enum | Değerler JSON kodlamasıyla aynı (camelCase). `ApiKeyScope` API'deki adlarla saklanır (`tx:prepare` …); A2A enum'ları ProtoJSON adlarıyla (`TASK_STATE_*`, `ROLE_*`) |
| Uzunluğu sözleşmede tanımlı olmayan metin | `TEXT` | Uydurma bir sınır konmaz. Sınırlar zod şemalarındaki değerlerdir (ör. `PolicyMeta.name` 120, `deliveryUri` 128) |

Biçim kısıtlarını Prisma şeması ifade edemez. Bu yüzden [`db/scripts/check-constraints.mjs`](../../db/scripts/check-constraints.mjs) bunları sütun tipinden türetir ve migration'a SQL olarak eklenir. Test, şemadaki her kısıtın veritabanında bulunduğunu denetler.

## 4. Yapılandırma

| Değişken | Kullanan | Not |
|---|---|---|
| `DATABASE_URL` | istemci, migration'lar, seed | Varsayılanı yok. `prisma generate` gerektirmez, migration komutları gerektirir |
| `SQUARE_PROGRAM_ID_{REGISTRY,POLICY,VERIFIER,ESCROW}` | seed | Program kimlikleri yapılandırmadan gelir (BC-09; SDK gibi). IDL'deki adres kullanılmaz |

Seed yalnızca `programs` tablosunu yazar: gerçek program kimlikleri ve IDL sürümleri. Örnek ya da sahte kayıt yoktur.

## 5. Migration akışı

```bash
# Şemayı değiştir, sonra geliştirme veritabanına karşı:
pnpm --filter @squaresdk/solana-db exec prisma migrate dev --create-only --name <ad>
# Yeni sütunların biçim kısıtlarını migration.sql'e ekle:
node db/scripts/check-constraints.mjs   # tüm kısıtları yazdırır; yalnızca yenileri ekle
# Uygula:
pnpm --filter @squaresdk/solana-db migrate:deploy
pnpm --filter @squaresdk/solana-db seed
```

Dağıtımda migration'lar `prisma migrate deploy` ile uygulanır; Prisma CLI bu yüzden runtime bağımlılığıdır. `prisma generate` turbo'da ayrı bir görevdir: `build` ve `typecheck` bu göreve bağlıdır, istemci (`db/src/generated/`) commit'lenmez.

## 6. Testler için izole veritabanı

`@squaresdk/solana-db/testing` → `startIsolatedDatabase()`:

- her çağrı kendi Postgres konteynerini açar ([Testcontainers](https://node.testcontainers.org/), Docker gerekir);
- migration'ları gerçek `prisma migrate deploy` ile uygular;
- `client`, `truncate()` ve `stop()` döner.

Bir servis testlerinde bunu kullanacaksa `@testcontainers/postgresql`'i devDependency olarak ekler (pakette isteğe bağlı peer). Testlerdeki imaj sürümü üretimdeki Postgres ana sürümüyle aynı tutulur (`TEST_POSTGRES_IMAGE`, BE-05).

`db/test/` şunları denetler: migration temiz veritabanında uygulanıyor ve şemayla arasında sapma yok (`prisma migrate diff --exit-code`), biçim kısıtları, tekillikler, cascade, keeper sorgusu ve seed.

## 7. Kaynaklardan farklar

| Kaynak | Ne oldu |
|---|---|
| Covenant `app/prisma/schema.prisma` (Neon) | Kopyalanmadı: `app/` LGPL-2.1 ve yeniden lisanslama onayları (BC-03) bekleniyor. Şema Square sözleşmesinden (IDL + OpenAPI) baştan yazıldı. Covenant'ın gamification ve arena tabloları zaten kapsam dışı. |
| Aperture compliance-api (ham `pg`) | `verified_payment_intents` alanları `mpp_payments`'a uyarlandı (Aperture MIT). compliance-api BE-25'e kadar kendi migration'larıyla çalışır. |
| AIP Supabase (`scripts/schema.sql`) | `tasks`, `escrows`, `automations`, `agent_memory`, `hosted_agents` … AIP uygulamasına ait ve kapsam dışı. A2A görev deposu `a2a_tasks` ve `a2a_messages` (BE-17). |

## 8. Şema review'u

- [x] Her API görünümü ve filtresi bir tabloya ve indekse karşılık geliyor (§2, `docs/api/openapi.yaml` sorgu parametreleri).
- [x] Ayna tablolar yalnızca zincirde olan değerleri taşıyor; zincir dışı veri ayrı tablolarda.
- [x] Gizli veri düz metin değil (oturum / anahtar hash'i, şifreli Travel Rule).
- [x] u64, hash ve adres biçimleri veritabanında da zorlanıyor.
- [x] Migration temiz veritabanında yeşil ve şemayla sapma yok (test).

## 9. Açık noktalar

1. **Postgres sürümü (BE-05):** Test imajı `postgres:17-alpine`. Railway'deki sürüm farklıysa `TEST_POSTGRES_IMAGE` buna eşitlenir.
2. **MPP ↔ job bağı (BE-25):** `mpp_payments.institution` ve `job` alanları ADR ile kesinleşir.
3. **Event şeması (BC-16):** Normatif event şeması ayna tablolara sütun ekleyebilir. Ekleme yeni bir migration ile yapılır.
4. **Travel Rule (BE-23):** KMS sağlayıcısı ve AEAD seçimi BE-23'te belirlenir. Tablo bunları `algorithm` ve `kms_key_id` olarak taşır.
