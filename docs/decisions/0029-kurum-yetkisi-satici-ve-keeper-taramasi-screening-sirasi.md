# ADR 0029: Policy'li işte kurum yetkisi, alacak satıcısının ve keeper'ın taranması, screening kaydının sırası

- **Durum:** Önerildi
- **Issue:** P-02 (#237), P-03 (#238), P-04 (#239)
- **Karar kaynağı:**
  - BC-39 iç incelemesinin P-02, P-03 ve P-04 bulguları ve önerileri ([review-bc-39.md](../security/review-bc-39.md) §3);
  - bu taslak (2026-10-07). Seçenekleri ve öneriyi yazar; karar proje sahibinindir.
- **Değiştirdiği karar:**
  - [ADR 0013](0013-release-keeper-ucreti-iade-ve-itibar.md) madde 1: Keeper ücreti yalnızca kaydı temiz ve taze
    keeper'a ödenir (madde 3).
  - [ADR 0014](0014-alacak-piyasasi-satici-ve-alici-kurallari.md) madde 1 ve 2: Listeleme ve alım satıcının
    kaydını da ister (madde 2).
- **Kapsam:**
  - `programs/square-escrow`:
    - kurum talimatları: `fund_job`, `commit_travel_rule`, `cancel_job`, `cancel_fiat_job`, `raise_dispute`;
    - kuruma ödeme yapanlar: `finalize_payment`, `execute_resolution`, `lapse_dispute`;
    - alacak: `list_claim`, `buy_claim`.
  - `programs/square-registry`: `record_screening`, `ScreeningRecord`.
  - `crates/square-common`: screening okuyucusu.
  - SDK akışları, `apps/screener`, `apps/keeper`, web.
  - Program ve API sözleşmeleri, runbook'lar.

## Bağlam

- **P-02 (orta): Multisig'e geçişte açık işlerin yetkisi açan anahtarda kalır.**
  - Escrow'un kurum talimatları yalnızca `has_one = institution`'ı denetler. Bunlar `fund_job`, `cancel_job`,
    `commit_travel_rule`, `raise_dispute` ve `cancel_fiat_job`'dur (`InstitutionJob`). `Job.institution`, işi açan
    imzacıdır.
  - Kuruma giden ödemeler de `Job.institution`'ın token hesabına yapılır:
    - `cancel_job`'un iadesi;
    - `finalize_payment`'in kesin ret iadesi ve vault fazlası;
    - `execute_resolution`'ın kurum payı;
    - `lapse_dispute`'un bond iadesi.

    Hepsinde kısıt `institution_token_account.owner == job.institution`'dır.
  - `set_institution_multisig`'ten sonra policy ve verifier yalnızca vault'u yetkili sayar:
    `Institution::authority()` = `multisig_vault.unwrap_or(owner_key)`.
  - LiteSVM'de doğrulanan senaryo ([review-bc-39.md](../security/review-bc-39.md#p-02-multisige-geçişte-açık-işlerin-yetkisi-açan-anahtarda-kalır-orta)):
    1. Kurum anahtarı policy'li bir işi açar ve fonlar.
    2. Anahtar sızar; kurum multisig bağlar.
    3. Eski anahtar `cancel_job` ile iadeyi kendi hesabına alır.

    Yeni vault bu işi yönetemez; ama ispatı yalnızca o bağlayabilir.
  - `Job` PDA'sının seed'i `["job", job.institution, spec_hash]`'tir. Bütün escrow talimatları adresi bu
    alandan yeniden türetir; alan değişirse adres de değişir.
- **P-03 (orta): Alacak satışında satıcı, finalize'da keeper taranmaz.**
  - Screening fonlamada (kurum ve agent), alımda (alıcı, ADR 0014 madde 2.7) ve release'te (payee, ADR 0013
    madde 3) yapılır.
  - Fiyatı alan satıcı (`listing.seller`) taranmaz. Ücreti alan keeper da taranmaz; ADR 0013 madde 1'e göre
    ücret her dalda çağırana ödenir.
  - [ADR 0016](0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md) Gerekçe, madde 7: "yaptırımlı bir adrese
    hiçbir ödeme yapılmaz".
  - Senaryo: Agent cüzdanı teslimden sonra `Flagged` olur ve finalize bekler. Agent alacağı listeler,
    taranmış bir alıcı alır (alıcı kökü sıfırsa herhangi bir cüzdan) ve fiyat işaretli cüzdana gider.
- **P-04 (orta): Screening kaydında yazım sırası yok.**
  - `record_screening` `init_if_needed`'dir; son yazan kazanır.
  - `screened_at` işlemin anıdır (Clock), kararın anı değildir. `expires_at = screened_at + screening_ttl_secs`.
  - Screener aynı cüzdanın eşzamanlı taramalarını süreç içinde birleştirir (istek ve yenileme;
    [`apps/screener/src/screener.ts`](../../apps/screener/src/screener.ts)). Kendi tx'inden sonra kaydı başka bir
    yazmanın değiştirdiğini görürse yalnızca loglar (`screening_record_mismatch`).
  - Senaryo: İki screener örneği aynı cüzdanı tarar. Yeni listeyle verilen `Flagged` önce zincire girer, eski
    listeyle verilen `Clear` sonra. Cüzdan bir kayıt ömrü boyunca (devnet'te 30 gün) fonlama, alım ve ödeme
    kapılarından geçer.
  - `ScreeningRecord`'da boş bayt yoktur (`SPACE = 8 + 32 + 1 + 32 + 8 + 8 + 1`). Alan eklemek hesabın boyutunu
    değiştirir.

## Değerlendirilen seçenekler

**P-02:**
- **A. Policy'li işte yetki `Institution`'dadır:** Escrow kurum talimatlarında ve kuruma ödemelerde
  `Job.institution` yerine `Institution::authority()`'yi kullanır.
  - Multisig bağlandığı anda bütün açık policy'li işler vault'a geçer. Tek tx'tir ve yarış yoktur.
  - `Job` hesabı ve PDA'sı değişmez.
  - Maliyet: sekiz talimata iki salt okunur hesap eklenir (`policy`, `policy_institution`). Permissionless
    talimatlarda bunları da çağıran geçirir; SDK çözer.
- **B. `job.institution`'ı taşıyan bir talimat** (`sync_agent_wallet`'ın karşılığı):
  - `Job.institution` PDA seed'inde olduğu için alan taşınamaz; `Job`'a yeni bir yetkili alanı gerekir.
  - İş başına bir tx'tir. Bağlamayla taşıma arasında eski anahtar işlem yapabilir.
- **C. Yalnızca runbook:** "Anahtar sızınca önce açık işleri iptal et."
  - Sızmış anahtar daha önce davranabilir.
  - Teslim edilmiş iş iptal edilemez; iadesi yine açanın hesabına gider.

**P-03, satıcı:**
- **Alımda tarama:** Ödeme anıdır, bağlayıcı denetim budur.
- **Listelemede de tarama:** Erken ret sağlar; satılamayacak bir listeleme açılmaz.

**P-03, keeper:**
- **K1. Keeper taranır, taranmamış keeper finalize edemez:**
  - Finalize, kaydı olan cüzdanlara kapanır.
  - Payee ya da kurum kaydı olmadan kendi işini kapatamaz; kapanış screener'ın sağlığına bağlanır.
- **K2. Taranmamış keeper'a ücret ödenmez:**
  - Finalize herkese açık kalır. Kaydı temiz ve taze olmayan çağıranın ücreti kuruma döner.
  - Payee'nin neti değişmez, ispat aynı kalır. Kayıt süresi dolan keeper ücretini kaybeder.

**P-04:**
- **S1. Kararın anı argümandır:** Screener kaynakları sorduğu anı (`decided_at`) yazar. Program saklanandan eski
  kararı reddeder.
  - Sırayı kararın kendisi verir; eşzamanlı yazanların birbirini bilmesi gerekmez.
  - Maliyet: hesaba 8 bayt ve eski kayıtlar için göç.
- **S2. Beklenen önceki `screened_at` ile yazma (compare-and-swap):** Kayıp güncellemeyi önler, karar sırasını
  vermez.
  - `Flagged` yazıldıktan sonra durumu okuyan bir `Clear` yazıcısı denetimi geçer, oysa kararı daha eskidir.
  - Çakışmada yeniden tarama ister.
- **S3. Screener'ın sıra numarası:** Örnekler arasında paylaşılan bir sayaç ister (zincir dışı durum). Sayaç
  kaybolursa ya da bölünürse sıra bozulur.

## Karar

1. **Policy'li işte kurum yetkisi (P-02, seçenek A):**
   - **Kurum kimdir:** Policy'li işte (escrow ve fiat rayı) kurum, `Institution::authority()`'dir: multisig
     bağlıysa vault, değilse `owner_key`.
   - **Okuma:** Escrow `Policy`'yi okur (`job.policy`, owner policy programı, PDA kaydın alanlarından), ardından
     `Institution`'ı (`policy.institution`, owner ve PDA aynı yolla). Yanlış hesap `PolicyMismatch` ya da
     `LinkedProgramMismatch` alır.
   - **İmzacı:** `fund_job`, `commit_travel_rule`, `cancel_job`, `cancel_fiat_job` ve `raise_dispute`'ta
     policy'li işte imzacı güncel yetkili olmalı; değilse `Unauthorized`.
   - **Para:** Kuruma giden her ödeme, policy'li işte güncel yetkilinin token hesabına yapılır:
     - fonlama iadesi;
     - kesin ret iadesi;
     - vault fazlası;
     - dispute'ta kurum payı;
     - bond iadesi.

     `fund_job`'un kaynak hesabı ve kurum screening'i de güncel yetkilinindir.
   - **Değişmeyenler:**
     - `Job` hesabı ve PDA seed'i değişmez; `job.institution` açanın kaydı olarak kalır.
     - ADR 0014'teki "kurum alıcı olamaz" kuralı hem açanı hem güncel yetkiliyi kapsar.
   - **Policy'siz iş:** Yetki açan anahtarda kalır. Kurum anahtarının sızıntısı için bir runbook yazılır (bugün kurum
     için runbook yok): "policy'siz açık işleri iptal et; multisig bağlamak policy'li işleri hemen taşır".
2. **Alacak satıcısının taranması (P-03):**
   - `buy_claim` satıcının kaydını ister (`["screening", listing.seller]`): temiz ve taze olmalı. Değilse
     `ScreeningRequired`, `ScreeningFlagged` ya da `ScreeningExpired`; para hareket etmez.
   - `list_claim` agent cüzdanının kaydını aynı kuralla ister.
3. **Keeper ücreti (P-03, seçenek K2):**
   - `finalize_payment`, çağıranın kaydını alır (`["screening", keeper]`). Kayıt temiz ve tazeyse ücret
     keeper'a ödenir. Kayıt yoksa, işaretliyse ya da süresi dolmuşsa ücret kuruma (madde 1'deki güncel
     yetkiliye) döner.
   - Finalize herkese açık kalır. Payee'nin neti ve ispatın tazeliği değişmez.
   - `Finalized.keeper_fee` ödenen ücreti yazar; tutulan ücret 0 görünür.
4. **Screening kaydının sırası (P-04, seçenek S1):**
   - `record_screening`'e `decided_at: i64` argümanı eklenir: screener'ın kaynakları sorduğu an.
   - Program şunları reddeder (yeni hata `StaleScreeningDecision`):
     - zincir saatinden 600 s'den fazla ileri bir an (ADR 0012'nin toleransı);
     - `decided_at + screening_ttl_secs <= now`, yani yazıldığı anda dolmuş bir karar;
     - saklanan `decided_at`'tan eski bir karar;
     - saklananla aynı anda verilmiş bir `Clear`, saklanan `Flagged` ise. Eşitlikte `Flagged` kazanır.
   - `expires_at = decided_at + screening_ttl_secs`. Kayıt kararın yaşıyla dolar, tx'in gecikmesiyle uzamaz.
   - **Hesap ve göç:**
     - `ScreeningRecord`'un sonuna `decided_at: i64` eklenir.
     - `record_screening` eski boyuttaki kaydı yeni boyuta genişletir; farkın rent'ini `payer` öder.
     - Okuyucular (`square_common::screening`) eski boyuttaki kaydı `decided_at = screened_at` sayar.
   - **Screener:** Reddedilen karar yeniden gönderilmez. Denetim kaydında `superseded` olarak kalır.
5. **Sözleşmeler ve dağıtım:**
   - Program sözleşmesi MINOR artar:
     - escrow: on talimatın hesap listesi;
     - registry: `record_screening`'in argümanı, `ScreeningRecord`'un alanı ve yeni hata.
   - API sözleşmesi IDL'den üretilen şemalarla MINOR artar. SDK akışları yeni hesapları kendisi çözer.
   - Devnet'e escrow ve registry'nin Squads upgrade'iyle çıkar. Üç madde aynı program sürümünde çıkarsa tek
     upgrade yeter.

## Gerekçe

Kaynak ([review-bc-39.md](../security/review-bc-39.md)) bulguları ve seçenekleri verir, aralarında seçim yapmaz.
Aşağıdaki gerekçe bu taslağı hazırlayanın değerlendirmesidir; kayıtlı olgulara dayanır.

- **Madde 1:**
  - Policy ve verifier kurumu zaten `Institution::authority()` ile tanır. Escrow'un aynı kaynağı okumasıyla
    kurum yetkisinin programlarda tek tanımı olur.
  - B seçeneği PDA seed'i yüzünden yeni bir alan ve iş başına bir tx ister. C seçeneği teslim edilmiş işi
    korumaz.
  - Paranın da güncel yetkiliye gitmesi gerekir. Yoksa sızmış anahtar iadeleri yine kendi hesabında toplar.
- **Madde 2:**
  - ADR 0016'nın kuralı her ödemeye uygulanır. Alımda fiyat satıcıya ödenir.
  - Fonlama iki tarafı, ödeme parayı alan payee'yi tarar. Alımda ise parayı alan satıcı taranmıyor.
- **Madde 3:**
  - K1, release'in canlılığını keeper'ların screening kaydına bağlar. ADR 0013 ise finalize'ı herkese açık
    tutar.
  - K2 hem kuralı (taranmamış adrese ödeme yok) hem açıklığı korur. Ücretin kuruma dönmesi, vault fazlasının
    yoluyla aynıdır (ADR 0013 madde 7).
- **Madde 4:**
  - Screening'in sorusu "bu kararın verildiği andaki listelere göre" sorusudur. Sıra da kararın anından
    gelmelidir.
  - S2 eşzamanlılığı çözer ama sırayı çözmez. S3 zincir dışı ortak durum ister.
  - Eşitlikte `Flagged`'in kazanması fail-closed kuralının devamıdır ([ADR 0020](0020-sanctions-screening-kaynaklari-ve-saglayici.md) madde 3).

## Sonuçlar

- **Uygulama:** P-02 (#237), P-03 (#238) ve P-04 (#239) bu ADR'nin maddeleridir. Uygulamalar madde başına ayrı
  PR olabilir ya da tek program sürümünde birleşebilir.
- **İstemciler:**
  - SDK: `flow.fundJob`, `commitTravelRule`, `cancelJob`, `cancelFiatJob`, `raiseDispute`, `finalizePayment`,
    `executeResolution`, `lapseDispute`, `listClaim` ve `buyClaim` yeni hesapları çözer.
  - Keeper servisi kendi screening kaydını taze tutar. Kayıt temiz değilse alarm verir.
  - Screener `decided_at`'ı yazar ve `StaleScreeningDecision`'ı ayırır.
  - Web'in iş sayfası, policy'li işte kurum eylemlerini bağlı cüzdan güncel yetkiliyse açar (FE-21'in vault'u
    dahil).
- **Tx boyutu** ([tx-budget.md](../design/tx-budget.md)):
  - Policy'li `finalize_payment` üç hesap kazanır (`policy`, `policy_institution`, keeper kaydı). ALT'sız
    1039 bayttan yaklaşık 1138 bayta çıkar (hesap başına 32 bayt anahtar ve 1 bayt indeks).
  - 16 kardeşli `buy_claim` satıcının kaydıyla Square ALT'ında 1198 bayttan yaklaşık 1231 bayta çıkar; sınır
    1232'dir. Uygulamada ölçülür. Sığmazsa en derin liste bir kardeş kısalır ya da kayıt ALT'a girmez (cüzdan
    başına PDA'dır).
- **Belgeler:**
  - program arayüzü §2 (kurum rolü), §4 (okumalar), §10;
  - ADR 0013 ve ADR 0014'ün değişen maddelerine bu ADR'ye bağlantı;
  - kısıt matrisi;
  - screener runbook'u ve kurum anahtarının sızıntısı için yeni runbook.

## Açık noktalar

- **P-09 (#244):** Multisig bağlama yeni vault'un imzasını istemez. Madde 1 bağlanan vault'u açık işlerin de tek
  yetkilisi yaptığı için P-09'un etkisi artar; birlikte ele alınması önerilir.
- **P-10 (#245):** Screener rotasyonu eski kayıtları geçersiz kılmaz; madde 4'ün kapsamı dışındadır.
- **Keeper servisi:** Kaydı temiz değilken ücretsiz finalize edip etmeyeceği servisin yapılandırmasıdır
  (`KEEPER_MIN_MARGIN_BPS`).
