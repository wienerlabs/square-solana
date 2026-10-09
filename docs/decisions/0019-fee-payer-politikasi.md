# ADR 0019: Fee payer politikası: izinli talimatlar, sponsor anahtarının rolü, limitler ve anahtarın saklanması

- **Durum:** Önerildi
- **Issue:** BE-27 (#82)
- **Karar kaynağı:** BE-27 iş kalemleri ve kabul kriterleri ("izinsiz ix'ler imzalanmıyor", "smart account ile
  8 adım sponsorlu geçiyor"); BC-35'in zincir tarafı (rol imzacısı ile `payer`'ın ayrılması, Squads vault
  imzacıları, `tests/programs/tests/squads.rs`); 2026-10-06
- **Kapsam:** `apps/fee-payer`, `@squaresdk/solana-sdk/squads`, `db` (`sponsored_txs`)

## Bağlam

- **Zincir tarafı (BC-35):** Programlar rol imzacısını rent ve ücret ödeyen `payer`'dan ayırır. Squads v4 vault
  PDA'ları rol imzacısı olabilir. Testte sekiz adımın ücretini ve rent'ini rolü olmayan bir sponsor öder; sponsor
  kurumun politikasını yazamaz, işi fonlayamaz, kabul edemez. Rent kapanışta kayıtlı `rent_payer`'a döner.
- **Risk:** Sponsor anahtarı her sponsorlu tx'i imzalar. İmza tx'in bütün talimatlarını kapsar. Denetlenmeyen
  bir tx sponsorun SOL'ünü aktarabilir (System `transfer` kaynağı), sponsoru bir hesabın yetkilisi ya da
  multisig üyesi yapabilir, yüksek priority fee ya da sınırsız rent ödetebilir.
- **Squads v4'te senkron yürütme yoktur** (`@sqds/multisig` 2.1.4 IDL'i). Vault'un imzası
  `vault_transaction_execute` içinde `invoke_signed` iledir. Vault tx'i öneri (`vault_transaction_create`,
  `proposal_create`, `proposal_approve`) ve yürütme işlemlerinden oluşur. Yürütmede iç mesajdaki vault dışı
  imzacılar dış işlemin imzacısı olmalıdır: iç talimattaki `payer` sponsorsa sponsor yürütmeyi de imzalar.

## Karar

1. **Ayrı servis:** Sponsorlu imza `apps/fee-payer`'dadır (API'den ayrı süreç, ayrı gizli anahtar). Uç
   `POST /v1/sponsor`; kimlik API'nin oturumu ya da `tx:prepare` kapsamlı API anahtarıdır. Sponsorlu imza tx
   hazırlığının parçası sayılır, yeni kapsam eklenmez.
2. **Tx biçimi:** Yalnızca v0 tx. Ücret ödeyicisi sponsor anahtarıdır. Kullanıcının verdiği imzalar
   doğrulanır. `submit: true` ise bütün imzalar gerekir ve servis gönderir; değilse sponsorun imzaladığı tx döner.
3. **İzin listesi** `<program>:<talimat>` biçimindedir. Square talimatları IDL discriminator'ıyla, Squads
   talimatları resmi paketin discriminator'larıyla, System / Token / ATA / Compute Budget talimat indeksiyle
   tanınır. Liste `FEE_PAYER_ALLOWED_INSTRUCTIONS` ile değiştirilebilir. Varsayılan liste:
   - **registry:** `register_agent`, `update_agent`, `set_agent_status`, `transfer_agent_ownership`,
     `deregister_agent`.
   - **policy:** `init_institution`, `set_policy`, `update_policy`, `set_buyer_root`,
     `set_institution_multisig`, `deactivate_policy`.
   - **verifier:** `set_preflight_proof` (P-01, ADR 0028), `set_compliance_proof`, `verify_mpp_payment_proof`.
   - **escrow:** `create_job`, `commit_travel_rule`, `fund_job`, `accept_job`, `submit_work`, `list_claim`,
     `buy_claim`, `cancel_claim`, `cancel_job`, `finalize_payment`, `raise_dispute`, `execute_resolution`,
     `lapse_dispute`, `escalate_missing_proof`, `sync_agent_wallet`; fiat rayı (BC-37, ADR 0024)
     `create_fiat_job`, `cancel_fiat_job`, `finalize_fiat_payment`.
   - **squads:** `multisig_create_v2`, `vault_transaction_create`, `proposal_create`, `proposal_approve`,
     `vault_transaction_execute`.
   - **Diğer:** `ata:create`, `ata:create_idempotent`, `computeBudget:set_compute_unit_limit`,
     `computeBudget:set_compute_unit_price`, `ed25519:verify` (yalnızca tek imzalı precompile talimatı: MPP
     attestation'ı, ADR 0024), `system:transfer`, `token:transfer_checked`,
     `token2022:transfer_checked`.

   Listede olmayanlar:
   - Yönetici talimatları: `init_config`, `init_registry_config`, `init_verifier_config`,
     `update_registry_config`, `update_params`, `update_arbitrators`, `update_mpp_authority`.
   - Screener'ın `record_screening`'i ve hakemin `resolve_dispute`'u (servis anahtarlarıyla, kendi ücretleriyle).
   - CPI'ye özel `record_release`.
   - Diğer Squads talimatları (yapılandırma işlemleri, batch, spending limit).
4. **Sponsorun rolü:** Sponsor anahtarı ücret ödeyiciliği dışında yalnızca "ödeyici" yerlerinde durabilir:
   - Square talimatlarının `payer` (rent öder) ve `rent_payer` (rent'in döndüğü hesap) hesapları;
   - ATA açılışının `payer`'ı;
   - Squads `multisig_create_v2`'nin `creator`'ı (rent ve Squads oluşturma ücreti);
   - `vault_transaction_create` ile `proposal_create`'in `rent_payer`'ı.

   System talimatında sponsor hiç duramaz (`sponsor_drain`). Başka herhangi bir yerde (imzacı, yetkili, token
   sahibi ya da yetkilisi, multisig üyesi, yazılabilir hesap) tx reddedilir (`sponsor_account_misuse`).
   Denetim tx'in bütün hesaplarıyla yapılır: address lookup table'lar zincirden çözülür.
5. **Squads vault tx'leri:** İç mesaj dış talimatlarla aynı kurallardan geçer. Öneride mesaj
   `vault_transaction_create`'in argümanıdır. Yürütmede mesaj zincirdeki VaultTransaction hesabıdır; hesap aynı
   tx'te açılıyorsa onun mesajıdır. İç mesajda compute budget ve Squads talimatı olmaz, lookup table
   kullanılmaz. Yürütmenin kalan hesapları mesajın hesaplarıyla birebir aynıdır. Model BC-35 testleridir:
   Square talimatının yetkilisi vault, `payer`'ı sponsordur; SDK `wrapInVault` bu biçimi üretir.
6. **Kötüye kullanım koruması:**
   - Tx en az bir Square ya da Squads talimatı taşır; sponsor genel amaçlı aktarımların ücretini ödemez.
   - Compute unit fiyatı (`FEE_PAYER_MAX_COMPUTE_UNIT_PRICE`) ve sınırı (`FEE_PAYER_MAX_COMPUTE_UNIT_LIMIT`)
     tavanlıdır; sınır verilmezse talimat başına 200 bin sayılır. Aynı compute budget talimatı iki kez geçmez.
   - Her tx imzadan önce simüle edilir. Düşecek tx imzalanmaz; blockhash'i geçersiz tx de imzalanmaz.
7. **Maliyet ve limitler:**
   - Ücret `getFeeForMessage`'dır. Rent, sponsorun simülasyondan önceki ve simülasyondaki bakiyesinin farkından
     ücret düşülerek bulunur. Bakiye `getBalanceAndContext` ile okunur ve simülasyon `minContextSlot` ile en az o
     slot'taki bir bankada yapılır. Daha eski bir bankadaki simülasyon aradaki sponsorlu tx'leri geri sayıp rent'i
     eksik gösterirdi; RPC o slota ulaşmadıysa istek `rpc_unavailable` ile düşer.
   - **ATA rent'i:** Sponsorun ödediği ve bu tx'te çalışan her ATA açılışı (`create`, `create_idempotent`; dış
     talimat ya da yürütülen vault mesajı) simülasyonun rent'ine ek olarak bir token hesabının rent'i
     (`getMinimumBalanceForRentExemption(165)`) olarak sayılır. `create_idempotent` hesap zaten varsa simülasyonda
     rent göstermez; hesap simülasyonla tx'in zincire girmesi arasında kapatılırsa sponsor rent'i öder. Ek sayım
     bu farkı her durumda bütçeye yazar. Hesap simülasyonda yeni açıldıysa rent iki kez yazılır; bu fazla
     bilinçlidir. Öneri tx'indeki (`vault_transaction_create`) vault mesajı o tx'te çalışmaz; ATA'sı yürütmede
     sayılır.
   - **Token-2022 hesabı:** Boyutu mint'in uzantılarına bağlıdır, rent'i önceden sınırlanamaz. Sponsor
     Token-2022 ATA'sının rent'ini ödemez (`sponsor_rent_unbounded`).
   - **Squads rent'i:** VaultTransaction ve Proposal hesaplarının rent'i kapanışta multisig'in
     `rent_collector`'ına döner. Sponsor `multisig_create_v2`'nin `creator`'ı ya da `vault_transaction_create` /
     `proposal_create`'in `rent_payer`'ı ise `rent_collector` yok ya da sponsor olmalıdır
     (`sponsor_rent_extractable`). Multisig zincirden okunur; aynı tx'te açılıyorsa açılışın argümanından.
     Açılan multisig'in üyeleri ve `config_authority`'si sponsor olamaz (`sponsor_account_misuse`).
   - **Aynı tx'in tekrarı:** Sponsorun imzası tx'in kimliğidir. Aynı tx ikinci kez gelirse ilk kayıt döner:
     bütçeye ikinci kez yazılmaz, gönderilmişse yeniden gönderilmez. Önceki sürümün `failed` yaptığı kayıt
     yeniden ölçülür.
   - **Gönderim hatası:** Servisin gönderimi hata verirse (zaman aşımı, RPC hatası) kayıt `signed` kalır ve
     bütçeye sayılır: sponsorun imzası blockhash süresince geçerlidir, tx yine de zincire girebilir ve 503
     yanıtı imzayı taşır. Aynı tx yeniden gönderilebilir; ikinci kez sayılmaz. Zincire hiç girmeyen tx'in
     maliyeti bugün geri verilmez.
   - Tek tx `FEE_PAYER_MAX_LAMPORTS_PER_TX`'i aşamaz.
   - Kullanıcı (cüzdan) başına ve servis toplamında günlük lamport bütçesi vardır (UTC günü). Bütçe
     `sponsored_txs` tablosundan, tek işlemde ve advisory kilitle denetlenir.
   - Cüzdan başına hız sınırı Postgres sayacıyladır (`@squaresdk/solana-hardening`).
8. **Sponsor anahtarının saklanması:**
   - Ayrı, yalnızca ücret ve rent için tutulan bir sıcak cüzdandır; programların hiçbirinde rolü yoktur.
   - Gizli anahtar yalnızca platformun gizli değişkenindedir (`FEE_PAYER_SECRET_KEY`, base58). Repoya, imaja ve
     log'a girmez; yapılandırma hatası anahtarı mesaja yazmaz.
   - Bakiye düşük tutulur ve elle doldurulur. `fee_payer_balance_low` alarmı eşik altında çalar; günlük toplam
     bütçe, anahtar sızsa bile servis üzerinden harcanabilecek tutarı sınırlar.
   - Anahtar döndürmede yeni anahtar verilip servis yeniden başlatılır, eski anahtarın bakiyesi yenisine
     aktarılır. Önceki anahtarla imzalanıp dönen tx'ler blockhash süresi (~60–90 sn) dolunca geçersizleşir.
9. **Metrikler ve günlük:** Prometheus'ta istek sonucu, ret sebebi, ücret ve rent toplamı, tx başına CU ve
   maliyet, kullanıcının günlük toplamının dağılımı ve sponsor bakiyesi bulunur. Kullanıcı etiketi kardinalite
   yüzünden yoktur. Kullanıcı başına toplamlar `sponsored_txs`'te ve `GET /v1/sponsor/usage`'dadır.

## Gerekçe

- **İzin listesi ve ödeyici yerleri:** İmzanın kapsamını talimat düzeyinde sınırlar. BC-35'in modeli sponsorun
  yalnızca `payer` / `rent_payer` olduğu modeldir; programlar bu hesaplardan yalnızca rent alır ya da rent'i
  onlara döndürür. Yönetici ve servis talimatlarının kendi anahtarları ve ücretleri vardır; kullanıcı akışı
  değildirler.
- **İç mesajın denetimi zorunludur:** Yürütmede sponsor dış işlemin imzacısıdır. Mesajdaki sponsorlu bir
  System aktarımı bu imzayla geçer.
- **Ayrı servis ve ayrı anahtar:** Sıcak anahtarın saldırı yüzeyini API'den ayırır; sızıntı ya da hata
  durumunda servis tek başına durdurulabilir.
- **Bütçe ve kilit:** Kaynak gerekçe vermez. "Kullanıcı başı limit" ve "kötüye kullanım koruması" iş
  kalemlerinin servisin birden çok örneğiyle tutarlı uygulanması için seçildi.
- **Rent tabanı ve rent_collector:** Simülasyonla ölçülen maliyet, sonucu zincir durumuna bağlı olan
  talimatlarda (idempotent açılış) gerçek maliyetin altında kalabilir; bütçe gerçek harcamayı sınırlamazsa
  günlük toplam bütçe de bir devre kesici olmaz. Squads hesaplarının rent'i kapanışta başka bir adrese
  dönebiliyorsa sponsorun ödediği rent o adrese aktarılmış olur.

## Sonuçlar

- `apps/fee-payer`: politika (`src/policy.ts`, `src/catalog.ts`), maliyet ve bütçe (`src/sponsor.ts`,
  `src/ledger.ts`), metrikler. Her ret dalı ayrı testlidir. 8 adımın her tx'i (SDK akışı, Squads vault
  imzacılı, öneri + yürütme) politikadan geçer. Localnet'te (`SQUARE_LOCALNET=1`) SOL'süz kullanıcının
  `register_agent`'ı sponsorla zincire girer; ölçülen maliyet sponsorun bakiye farkına eşittir.
- **Devnet'te gerçek Squads v4 ile 8 adım** (`test/squads-devnet.e2e.test.ts`,
  [deploy kaydı](../deploy/devnet.md#fee-payer-ve-squads-smart-account-be-27)):
  - Üç smart account sponsorla açıldı.
  - 22 tx'in ücretini ve rent'ini sponsor ödedi; vault'lar hiç SOL tutmadı.
  - CU ve boyut ölçümleri [tx-budget.md §8](../design/tx-budget.md#8-sponsorlu-tx-ve-squads-vaultu)'dedir.
  - `finalize_payment`'ın açtığı iki kaydın rent'ini program keeper'a ödetir (`payer = keeper`). Keeper bunu
    ücretiyle karşılar.
- `@squaresdk/solana-sdk/squads`:
  - Vault ve multisig adresleri `square_common::squads` ile aynıdır; ortak vektörle denetlenir.
  - `createSmartAccountInstruction` (`multisig_create_v2`) ve `wrapInVault` resmi `@sqds/multisig` 2.1.4
    kodlayıcılarıyladır.
  - Talimat tablosu ve mesaj çözücüler servisin politikasında kullanılır.
- `db`: `sponsored_txs` tablosu ve `SponsoredTxStatus` (migration `20261006180000_fee_payer`).
- `apps/api/src/squads.ts` program kimliğini, discriminator'ı ve yetki bitlerini SDK'dan alır.

## Açık noktalar

- **Squads'ın LiteSVM profili:** Squads programı LiteSVM ortamında yok. Devnet ölçümü tx-budget §8'dedir; vault
  yürütmesinin sınırı simülasyonla seçilmelidir.
- **Anahtarı KMS ya da HSM'e taşıma:** İmza uzaktan yapılır, gizli anahtar süreçte durmaz. Railway dağıtımında
  karar verilecek.
- **Kullanıcı başına farklı bütçeler:** Ör. kurum planına göre. Şimdilik tek bir kullanıcı bütçesi var.
- **Kullanıcının kapatabildiği hesaplar:** ATA'nın sahibi hesabı kapatıp rent'i kendine alabilir. Sponsorun
  ödediği ATA rent'i bu yüzden kullanıcıya verilmiş sayılır; bütçeye yazılır, ama geri dönmez.
- **Gönderilemeyen tx'in maliyeti:** Gönderim hatasındaki kayıt bütçede kalır. Blockhash'in
  `lastValidBlockHeight`'ı geçtikten sonra imzası zincirde bulunmayan kayıtları `failed` yapacak bir uzlaştırıcı
  yok.
- **Squads rent'inin dönüşü:** `rent_collector` denetimi tx anındaki değeri okur. Multisig `rent_collector`'ı
  sonradan değiştirebilir (`config_authority` ya da üyelerin config işlemi). Kapanışta sponsorun ödediği
  VaultTransaction ve Proposal rent'i yeni adrese gider. Rent bütçeye yazılmıştır, ama sponsora dönmesi garanti
  değildir.
- **Bond vault'unun rent'i:** Sponsorlu `raise_dispute`'ta bond vault'unun rent'ini sponsor öder. Rent lapse ya
  da karar ödemesinde `job.rent_payer`'a döner; job'u başka ödeyiciyle açan kurum bu rent'i alır. Rent bütçeye
  yazılmıştır.
- **Sponsora gelen SOL:** Bakiye okuması ile simülasyon arasında sponsora gönderilen lamport o isteğin rent'ini
  eksik gösterir. Eksik, gönderilen tutar kadardır; saldırgan kazandığı bütçe kadar SOL öder.
- **`/ready`'nin RPC çağrısı:** Hazırlık denetimi her istekte sponsorun bakiyesini RPC'den okur ve önbelleği
  yoktur. Servisler ortak `createHealth`'i kullandığı için önbellek ya da hız sınırı ayrı bir iştir.
- **Bütçe kimliğe bağlıdır:** Kullanıcı bütçesi oturumun ya da API anahtarının cüzdanına göredir ve cüzdan
  açmak ücretsizdir. Bir saldırgan çok sayıda cüzdanla kullanıcı bütçelerini toplayabilir; servisin bir günde
  kaybedebileceği en büyük tutar servis toplam bütçesidir (`FEE_PAYER_GLOBAL_DAILY_LAMPORTS`). Kayıtlı katılımcılara
  (agent kaydı, kurum hesabı) bağlı bütçe ayrı bir karardır.
