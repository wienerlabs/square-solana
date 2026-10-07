# @squaresdk/solana-fee-payer

Sponsorlu işlem (fee payer) servisi (BE-27). Kullanıcı, kurum ya da agent rol imzacısıdır; işlemin ücretini ve
açılan hesapların rent'ini rolü olmayan bir sponsor anahtarı öder. Programlar bunu destekler: rol imzacısı
rent / ücret ödeyen `payer`'dan ayrıdır ve Squads v4 vault PDA'ları rol imzacısı olabilir (BC-35,
`tests/programs/tests/squads.rs`). Politika, limitler ve anahtarın saklanması
[ADR 0019](../../docs/decisions/0019-fee-payer-politikasi.md)'dedir.

| Uç | Görev |
|---|---|
| `POST /v1/sponsor` | Kısmen imzalı ya da imzasız v0 tx'i denetler, simüle eder, bütçeden düşer, sponsorla imzalar; `submit: true` ise gönderir |
| `GET /v1/sponsor/usage` | Çağıranın bugünkü (UTC) harcaması ve günlük bütçesi |
| `GET /v1/sponsor/info` | Sponsor adresi (tx'in `feePayer`'ı), izinli talimatlar ve tavanlar |
| `/health`, `/ready` (veritabanı, RPC) | `FEE_PAYER_PORT` |
| `GET /metrics` | `FEE_PAYER_METRICS_PORT` (iç ağ) |

Yanıt zarfı API'ninkiyle aynıdır (`{ success, data, error, meta }`).

## Kimlik ve limitler

- **Kimlik:** API'nin oturumu (`Authorization: Bearer sqs_…`) ya da `tx:prepare` kapsamlı API anahtarı
  (`X-API-Key: sqk_…`); aynı veritabanından doğrulanır ([apps/api](../api/README.md#kimlik)). Bütçenin öznesi
  istek sahibinin cüzdanıdır; API anahtarıyla gelen tx'in anahtar kimliği günlüğe yazılır.
- **Hız sınırı:** Cüzdan başına sabit pencere, Postgres sayacıyla (`@squaresdk/solana-hardening`). Aşan istek 429
  ve `Retry-After` alır.
- **Günlük bütçe:** Kullanıcı başına ve servis toplamında lamport bütçesi, UTC günü. Tx başına tavan
  `FEE_PAYER_MAX_LAMPORTS_PER_TX`. Bütçe `sponsored_txs` tablosundan, tek veritabanı işleminde ve advisory kilitle
  denetlenir; eşzamanlı istekler ve servisin birden çok örneği bütçeyi birlikte aşamaz. Gönderimi hata veren tx
  bütçede kalır: sponsorun imzası blockhash süresince geçerlidir ve tx yine de zincire girebilir.

## Politika

Tx imzalanmadan önce çözülür ve denetlenir ([`src/policy.ts`](src/policy.ts)). Ret 403 `forbidden`, bütçe 429
`rate_limited`, simülasyon 422 `simulation_failed` döner; sebep `error.details.reason`'dadır:

| `reason` | Kural |
|---|---|
| `invalid_transaction` | Tx base64 v0 tel biçiminde değil ya da 1232 baytı aşıyor (400) |
| `unsupported_version` | Legacy tx |
| `fee_payer_mismatch` | Ücret ödeyicisi sponsor değil |
| `invalid_signature` / `missing_signatures` | Verilen imza geçersiz / `submit: true` iken imza eksik |
| `lookup_table_not_found` | Address lookup table ya da girdisi zincirde yok |
| `program_not_allowed` / `instruction_not_allowed` | Program ya da talimat izin listesinde değil (yönetici talimatları dahil) |
| `sponsor_drain` | Sponsor bir System talimatının hesabı (SOL aktarımı vb.) |
| `sponsor_account_misuse` | Sponsor ücret / rent dışı bir yerde (imzacı, yetkili, token sahibi, yazılabilir hesap) |
| `duplicate_compute_budget`, `compute_unit_price_too_high`, `compute_unit_limit_too_high` | Compute budget tavanları |
| `invalid_squads_message`, `inner_lookup_table`, `squads_transaction_not_found`, `squads_accounts_mismatch` | Squads vault tx'i çözülemiyor, iç mesaj ALT kullanıyor, yürütülen VaultTransaction yok ya da hesaplar mesajla aynı değil |
| `squads_multisig_not_found` | Sponsorun `rent_payer` olduğu vault tx'inin multisig'i zincirde yok |
| `sponsor_rent_unbounded` | Sponsor bir Token-2022 ATA'sının rent'ini ödeyecek (boyutu mint uzantılarına bağlı) |
| `sponsor_rent_extractable` | Sponsorun ödediği Squads rent'i başka bir `rent_collector`'a dönecek |
| `no_square_instruction` | Tx'te Square ya da Squads talimatı yok |
| `simulation_failed` | Simülasyon başarısız ya da blockhash geçersiz (422, `programError` IDL adıyla) |
| `tx_cost_too_high` | Ücret + rent tx başına tavanın üstünde |
| `daily_budget_exceeded` / `global_budget_exceeded` / `rate_limited` | Bütçe ve hız sınırı (429) |
| `send_failed` | `submit: true` gönderimi RPC'de hata verdi (503; maliyet bütçede kalır, aynı tx yeniden gönderilebilir) |

Sponsorun durabileceği "ödeyici" yerleri: Square talimatlarının `payer` ve `rent_payer` hesapları, ATA
açılışının `payer`'ı, Squads `multisig_create_v2`'nin `creator`'ı ve `vault_transaction_create` /
`proposal_create`'in `rent_payer`'ı. Varsayılan izin listesi [`src/catalog.ts`](src/catalog.ts)'teki
`DEFAULT_ALLOWED_INSTRUCTIONS`'tır; `FEE_PAYER_ALLOWED_INSTRUCTIONS` ile değiştirilebilir.

Maliyet: sponsorun ödediği her ATA açılışı en az bir token hesabının rent'i olarak bütçeye yazılır, simülasyon
hesabın var olduğunu gösterse bile (`create_idempotent`). Aynı tx ikinci kez gelirse ilk kayıt döner, ikinci
kez ücretlenmez ve gönderilmez. Servisin bir günde kaybedebileceği en büyük tutar
`FEE_PAYER_GLOBAL_DAILY_LAMPORTS`'tur: kullanıcı bütçeleri cüzdana göredir ve cüzdan açmak ücretsizdir
([ADR 0019](../../docs/decisions/0019-fee-payer-politikasi.md) §7, açık noktalar).

## Squads smart account

Smart account ve vault tx'leri SDK'nın `@squaresdk/solana-sdk/squads` alt yoluyla kurulur:

```ts
import {
  SquadsPermission, builtTxInstructions, createSmartAccountInstruction, readSmartAccount, readSquadsTreasury, wrapInVault,
} from '@squaresdk/solana-sdk/squads';

// Kurulum (sponsorlu): sponsor `creator`'dır, rent ve Squads oluşturma ücretini öder.
const { instruction, multisig, vault } = createSmartAccountInstruction({
  createKey: createKey.publicKey, creator: sponsor, treasury: await readSquadsTreasury(connection),
  members: [{ key: member, permissions: SquadsPermission.all }], threshold: 1,
});

// Bir adım: SDK akışı vault'u rol adresi, sponsoru `feePayer` olarak alır; talimatlar vault tx'ine sarılır.
const built = await client.flow.acceptJob({ agent: vault, job }, { feePayer: sponsor });
const plan = wrapInVault({ multisig, member, rentPayer: sponsor,
  transactionIndex: (await readSmartAccount(connection, multisig)).transactionIndex + 1n,
  instructions: builtTxInstructions(built) });
// plan.propose (create + proposal + approve) ve plan.execute ayrı tx'lerdir; ikisi de `POST /v1/sponsor`'a gider.
```

Servis öneri işleminde `vault_transaction_create`'in mesajını, yürütmede zincirdeki VaultTransaction hesabını
(aynı tx'te açılıyorsa onun mesajını) çözer ve iç talimatları aynı kurallarla denetler.

## Maliyet ve metrikler

Ücret `getFeeForMessage` (imza ücreti + priority fee); rent, sponsorun simülasyondan önceki bakiyesiyle
simülasyonun döndürdüğü bakiyesi arasındaki farktan ücret düşülerek bulunur (Agave'de simülasyonun hesap durumu
ücreti içerir; localnet testi ölçümün zincirdeki bakiye farkına eşit olduğunu denetler). Simülasyon bakiyenin
okunduğu slottan eski olmayan bir bankada yapılır (`minContextSlot`). Sponsorun ödediği ve tx'te çalışan her ATA
açılışı için simülasyonun rent'ine bir token hesabının rent'i eklenir ([ADR 0019](../../docs/decisions/0019-fee-payer-politikasi.md)
madde 7). Her tx `sponsored_txs`'e
yazılır: imza, cüzdan, API anahtarı, durum (`signed`, `submitted`; `failed` yalnızca eski kayıtlarda), ücret, rent, simülasyondaki compute
unit, sınır, fiyat ve denetlenen talimatlar (`vault>` önekiyle iç talimatlar).

| Metrik | Açıklama |
|---|---|
| `square_fee_payer_requests_total{outcome}` | `signed`, `submitted`, `rejected`, `failed` |
| `square_fee_payer_rejections_total{reason}` | Ret sebepleri (tablo yukarıda) |
| `square_fee_payer_fee_lamports_total`, `square_fee_payer_rent_lamports_total` | Sponsorun ödediği ücret ve rent |
| `square_fee_payer_compute_units`, `square_fee_payer_tx_cost_lamports` | Tx başına CU ve maliyet (histogram) |
| `square_fee_payer_user_daily_spend_lamports` | Her tx'ten sonra kullanıcının günlük toplamı (histogram; kullanıcı etiketi yok) |
| `square_fee_payer_balance_lamports` | Sponsorun son okunan bakiyesi |

**Alarmlar:** `fee_payer_errors` (iç ve bağımlılık hataları pencerede eşiğin üstünde), `fee_payer_balance_low`
(sponsor bakiyesi `FEE_PAYER_MIN_BALANCE_LAMPORTS`'un altında; değer eksik lamport).

## Çalıştırma

Migration'lar ve `programs` tablosunun seed'i servisten önce uygulanır (indexer'la aynı;
[apps/indexer](../indexer/README.md#çalıştırma)). Ortam değişkenleri [`.env.example`](.env.example)'dadır;
varsayılan değer yoktur. İmaj: `docker build -f apps/fee-payer/Dockerfile .` (repo kökünden).

```bash
pnpm turbo test --filter @squaresdk/solana-fee-payer   # Docker gerekir (Postgres)
# Gerçek localnet'e sponsorlu gönderim (Agave kurulu, programlar derlenmiş):
SQUARE_LOCALNET=1 SQUARE_PROGRAMS_DIR=<repo>/target/deploy SQUARE_LOCALNET_RPC_PORT=8899 \
  pnpm --filter @squaresdk/solana-fee-payer exec vitest run test/localnet.test.ts
```

Testler:
- **Ret dalları:** Her biri ayrı testli ([`test/policy.test.ts`](test/policy.test.ts)).
- **8 adımın tx'leri:** SDK akışıyla üretilir, Squads vault imzacılıdır (öneri + yürütme). Her biri politikadan
  geçer ve sponsorlanır ([`test/eight-steps.test.ts`](test/eight-steps.test.ts), fixture RPC).
- **Localnet:** SOL'süz kullanıcının `register_agent`'ı sponsorla zincire girer. Sponsordan SOL çeken tx
  gönderilmeden reddedilir ([`test/localnet.test.ts`](test/localnet.test.ts)).
- **Devnet:** [`test/squads-devnet.e2e.test.ts`](test/squads-devnet.e2e.test.ts) gerçek Squads v4 programıyla
  çalışır ([deploy kaydı](../../docs/deploy/devnet.md#fee-payer-ve-squads-smart-account-be-27)).
  - Üç smart account (kurum, agent, alıcı) sponsorla açılır.
  - 8 adımın 22 tx'i servisten geçer. Vault'lar hiç SOL tutmaz.
  - Release ispatı zincirden kurulan witness'la üretilen gerçek Groth16 ispatıdır.
  - Ödeme alıcı vault'una gider.

```bash
FEE_PAYER_E2E_SPONSOR=<SOL'ü olan sponsor keypair'i> FEE_PAYER_E2E_FUNDER=<devnet USDC'si olan keypair> \
FEE_PAYER_E2E_SCREENER=<screener authority keypair'i> \
  pnpm --filter @squaresdk/solana-fee-payer exec vitest run test/squads-devnet.e2e.test.ts
```

Funder ve screener yalnızca kurulumda kullanılır: vault'ların token hesapları, USDC ve screening kayıtları.

**Keeper'ın rent'i:** `finalize_payment`'ın açtığı `AgentReputation` ve `ValidationRecord`'un rent'ini program keeper'a
ödetir (`payer = keeper`). Keeper bunu keeper ücretiyle karşılar. Tx'in ücreti sponsorludur; devnet testi keeper'ın
SOL'ünün yalnızca bu iki rent'e gittiğini denetler.

**Kalan:** Railway dağıtımı ve sponsor anahtarının KMS'e taşınması ADR 0019'un açık noktalarındadır.
