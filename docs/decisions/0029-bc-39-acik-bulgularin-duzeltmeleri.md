# ADR 0029: BC-39 iç incelemesinin açık bulgularının düzeltmeleri

- **Durum:** Önerildi
- **Issue:** P-02 (#237), P-03 (#238), P-04 (#239), P-05 (#240), P-06 (#241), P-08 (#243), P-09 (#244), P-10 (#245),
  P-11 (#246), P-12 (#247), P-13 (#248), P-14 (#249), P-15 (#250), P-16 (#251), P-17 (#252), P-18 (#253), P-19 (#254)
- **Karar kaynağı:**
  - BC-39 iç incelemesinin bulguları ve önerileri ([review-bc-39.md](../security/review-bc-39.md) §3);
  - bu taslak (2026-10-07). Seçenekleri ve öneriyi yazar; karar proje sahibinindir.
- **Kapsam dışı:**
  - P-01 (#236): [ADR 0028](0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md), #262;
  - P-07 (#242) ve P-20 (#255): tek ve net önerileri var, #265;
  - P-21 (#256): #257 ile düzeltildi.
- **Değiştirdiği karar:**
  - [ADR 0013](0013-release-keeper-ucreti-iade-ve-itibar.md) madde 1:
    - keeper ücreti yalnızca kaydı temiz ve taze keeper'a ödenir (madde 3);
    - ücret oranı işin açılışındaki orandır (madde 11).
  - [ADR 0014](0014-alacak-piyasasi-satici-ve-alici-kurallari.md):
    - madde 1 ve 2: listeleme ve alım satıcının kaydını da ister (madde 2), fiyat netin altında olmalıdır (madde 16);
    - madde 3: kapalı politikanın alıcı kökü güncellenebilir (madde 7).
  - [ADR 0024](0024-stripe-mpp-fiat-rayi.md): Vault isteyen escrow talimatlarında fiat işin reddi `RailMismatch`
    değil, hesap doğrulamasıdır (madde 14).
- **Kapsam:**
  - dört program: `square-escrow`, `square-registry`, `square-policy`, `square-verifier`;
  - `crates/square-common`: screening okuyucusu, Merkle ağacı, hesap yazımı;
  - `@squaresdk/solana-sdk`, `@squaresdk/solana-policy`;
  - `apps/screener`, `apps/keeper`, web;
  - program ve API sözleşmeleri, runbook'lar.

## Bağlam

Bulguların ayrıntısı, yeri ve senaryosu [review-bc-39.md](../security/review-bc-39.md) §3'tedir. Aşağıda kararın
dayandığı olgular var.

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
- **Düşük ve bilgi bulguları:**

  | Bulgu | Olgu |
  |---|---|
  | P-05 (#240) | Fiat işte payee yalnızca `create_fiat_job`'da taranır. `sync_agent_wallet` işi taranmamış cüzdana taşıyabilir. `finalize_fiat_payment` payee'yi taramadan release ve itibar yazar |
  | P-06 (#241) | `ReleaseProof`'ta doğrulama anahtarının sürümü ya da attestation'ın imzacısı yok. Upgrade'den ya da MPP anahtarının rotasyonundan önce bağlanan ispat, tazelik yalnızca gün ve sayaca baktığı için ertesi UTC günü boyunca tüketilebilir. #196'nın `sync_vk_version`'ı config'i günceller, bekleyen ispatları geçersiz kılmaz |
  | P-08 (#243) | `set_buyer_root` kapalı politikada reddedilir; `buy_claim` politikanın `active`'ine bakmaz. Kapalı politikanın listesinden alıcı çıkarılamaz. Sıfır kök kısıtsızdır |
  | P-09 (#244) | `set_institution_multisig` yeni vault'un imzasını istemez; bağlamayı çözen yol yok, `owner_key` döndürülemez. Yanlış multisig ya da `vault_index` kurumu kalıcı olarak kilitler |
  | P-10 (#245) | Screening kaydı onu yazan screener'ı tutmaz, okuyucu config'e bakmaz. Sızmış screener anahtarıyla yazılmış `Clear` kayıtları rotasyondan sonra da ömürleri boyunca geçerlidir |
  | P-11 (#246) | Config'lerin admin'i, bağlı program kimlikleri ve settlement mint'i yalnızca açılışta yazılır. Upgrade authority vault'u değişirse (ADR 0008) config'leri yalnızca eski vault yönetir |
  | P-12 (#247) | `validate_params` ve `validate_screening_ttl`'da üst sınır yok: `min_bond_bps` 10 000'i aşabilir; i64'e yakın bir süre pencere hesabını taşırır. `keeper_fee_bps` değişikliği açık işlere uygulanır ve bağlanmış ispatları bayatlatır |
  | P-13 (#248) | `transfer_agent_ownership` tek adımdır; yeni sahibin kabulü yok. Yanlış adrese devirde kayıt, itibar ve did:aip kimliği gider. Devir açık işleri taşımaz |
  | P-14 (#249) | `create_fiat_job` yalnızca `amount > 0` ister. API tam sent olmayan ya da 50 sentin altındaki işi ödemez (ADR 0026); böyle bir iş kabul edilip teslim edilir ama ödenemez |
  | P-15 (#250) | Anchor hesabı yazarken serileştirilmiş verinin ötesini sıfırlamaz. Değişken uzunluklu alanı olan hesaplar (`Job`: karar ve teslimat URI'si; `AgentRecord`: kart URI'si; `Institution`) küçülünce sonda eski baytlar kalır. `Job.rail` bu alanlardan sonradır; sonraki bir alan eski baytları okur |
  | P-16 (#251) | `fund_job`, `cancel_job`, `finalize_payment` ve dispute talimatları rayı denetlemez. Fiat işin vault'u hiç açılamadığı için bugün güvenli; vault'u isteyen talimat `RailMismatch` yerine `AccountNotInitialized` döner. Anchor hesapları kısıtlardan önce çözer; `job` üzerindeki bir ray kısıtı vault'un çözümünden önce çalışmaz |
  | P-17 (#252) | Token programı `Interface`'tir, Token-2022 kabul edilir. Transfer ücretli mint'te vault tutardan az alır ve kapanamaz; kalıcı delege vault'u boşaltabilir. Mint config'te sabittir; devnet'te Circle'ın USDC'si (klasik SPL Token) |
  | P-18 (#253) | `list_claim` yalnızca `price < amount` ister. `[amount − ücret, amount)` aralığında alan alıcı ödediğinden az alır |
  | P-19 (#254) | Merkle ağacında yaprak (`sha256(buyer ‖ leaf_salt)`) ve iç düğüm aynı biçimde hash'lenir. Alıcı imzacı olduğu için ikinci ön-görüntü pratik değil |

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

**Düşük ve bilgi bulguları:**

| Bulgu | Seçenekler | Öneri |
|---|---|---|
| P-05 | `finalize_fiat_payment`'te payee taraması · fiat işte `sync_agent_wallet` yeni cüzdanı tarar | İlki: ödeme kaydının anıdır, bütün yolları kapsar |
| P-06 | `ReleaseProof`'a VK sürümü ve MPP imzacısı, release'te güncel değerle karşılaştırma · upgrade ve rotasyondan sonra bir UTC günü ve 600 s boyunca bekleyen ispatları elle denetleyen runbook adımı | İlki: runbook adımı bir insanın dikkatine bağlıdır |
| P-08 | Kapalı politikada yalnızca kök güncellenir · kapalı politikanın işinde satış kapanır | İlki: ikincisi kurumun bir politika değişikliğiyle açık işlerin alacağını satılmaz yapar |
| P-09 | Tek tx'te hem güncel yetkili hem yeni vault imzalar · iki adım: güncel yetkili önerir, yeni vault kabul eder | İkincisi: vault yalnızca kendi Squads tx'inde imzalar; dış bir imzacıyla aynı yürütmede imzalaması Squads'ın kurallarına bağlıdır |
| P-10 | Kayda screener yazılır, okuyucu config'teki screener'la karşılaştırır · config'e `min_decided_at` dönemi, okuyucu ondan eski kaydı dolmuş sayar · yalnızca runbook | İkincisi: planlı rotasyon kayıtları geçersiz kılmaz; sızıntıda admin dönemi sızıntının anına çeker |
| P-11 | Güncel upgrade authority'yle doğrulanan admin rotasyonu · bağlı programları ve mint'i de değiştirilebilir yapmak | İlki: bağlı programlar ve mint bütün hesapların anlamını belirler, çalışırken değişmemeli |
| P-12 | Parametrelere üst sınır · ücret oranının işe kopyalanması | İkisi birlikte |
| P-13 | İki adımlı devir (bekleyen sahip, kabul) · `new_owner` imzacı | İlki: Squads vault'u gibi yalnızca kendi tx'inde imzalayabilen sahiplere de uyar |
| P-14 | Zincirde sent kuralı ve alt sınır · yalnızca API'de | İlki: ödenemeyecek iş açılmasın |
| P-15 | Yazımdan sonra serileştirilmiş verinin ötesini sıfırlamak · alan eklemeden önce sürümlü göç · değişken alanları sabit uzunluğa çevirmek | İlki, mevcut hesaplar için tarama ve gerekirse göç: üçüncüsü bütün hesapları göçe sokar |
| P-16 | Vault hesabını isteğe bağlı yapıp handler'da `RailMismatch` · bugünkü reddi belgelemek | İkincisi: ret güvenli; daha doğru bir hata kodu için arayüz değişikliği değmez |
| P-17 | `Program<Token>` · açılışta mint uzantısı denetimi ve fonlamada vault'un aldığı tutarın denetimi | İkincisi: Token-2022'nin uzantısız mint'leri desteklenir, tehlikeli uzantılar açılışta reddedilir |
| P-18 | `price < amount − keeper ücreti` · bugünkü kural | İlki |
| P-19 | Yaprak ve iç düğüme `0x00` / `0x01` öneki · bugünkü biçimi gerekçesiyle belgelemek | İlki: Square yalnızca devnet'te (ADR 0027); kökler bugün ucuza yeniden yayımlanır, dış audit'ten (BC-40, BC-41) önce standart biçim |

## Karar

**Yetki ve tarama:**

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
5. **Fiat işte payee taraması (P-05):** `finalize_fiat_payment` payee'nin (`job.agent_wallet`) kaydını ister:
   temiz ve taze olmalı, değilse `ScreeningRequired` / `ScreeningFlagged` / `ScreeningExpired` ve iş `Delivered`
   kalır. Escrow rayındaki ödeme kuralıyla aynıdır (ADR 0013 madde 3).
6. **Screener rotasyonunun dönemi (P-10):**
   - `RegistryConfig`'e `min_decided_at: i64` eklenir. `update_registry_config` onu ayarlar; geri alınamaz, yalnızca
     ileri gider.
   - Okuyucular `decided_at < min_decided_at` olan kaydı dolmuş sayar (`ScreeningExpired`). Escrow'un screening
     okuyan talimatları registry config'ini de okur; config'in PDA'sı Square ALT'ındadır.
   - Screener runbook'u: anahtar sızınca rotasyonla birlikte `min_decided_at` sızıntının anına çekilir ve kayıtlar
     yeniden taranır. Planlı rotasyonda dönem değişmez.
   - Madde 4'ün `decided_at`'ına dayanır.
7. **Kapalı politikanın alıcı kökü (P-08):**
   - `set_buyer_root` kapalı politikada da çalışır; kapalı politikada değişebilen tek alan köktür.
   - `buy_claim` değişmez: kök alım anında politikanın güncel hâlinden okunur (ADR 0014 madde 3).
   - "Kimse alamaz" sıfır olmayan, yaprağı olmayan bir kökle ifade edilir. `@squaresdk/solana-policy` bunu bir
     sabitle verir; program için ayrı bir durum gerekmez.
8. **Multisig'in iki adımla bağlanması (P-09):**
   - `propose_institution_multisig(multisig, vault_index)`: güncel yetkili önerir; multisig Squads v4'e ait ve
     başlatılmış olmalı (bugünkü denetim).
   - `accept_institution_multisig`: imzacı önerilen multisig'in türetilen vault'udur (Squads tx'iyle). Kabulde
     bağlama yazılır ve öneri silinir.
   - Güncel yetkili öneriyi geri çekebilir. Bağlı vault başka bir multisig'e geçişi de aynı iki adımla yapar.
   - `Institution`'a bekleyen öneri alanı eklenir (madde 15'in kuralıyla). Tek adımlı `set_institution_multisig`
     kalkar.
9. **Config admin'inin rotasyonu (P-11):**
   - Config'i olan programlara (escrow, registry, verifier) `sync_config_admin` eklenir. İmzacı programın güncel upgrade authority'sidir (`program_data` ile
     doğrulanır, açılıştaki gibi); config'in admin'i ona eşitlenir.
   - Bağlı program kimlikleri ve settlement mint değişmez.

**Parametreler ve tutarlar:**

10. **Parametrelerin üst sınırları (P-12):**

    | Parametre | Üst sınır | Devnet'teki değer |
    |---|---|---|
    | `min_bond_bps` | 10 000 | 1 000 |
    | `max_challenge_period` | 30 gün | 7 gün |
    | `proof_timeout_secs` | 30 gün | 1 gün |
    | `dispute_timeout_secs` | 30 gün | 7 gün |
    | `screening_ttl_secs` | 365 gün | 30 gün |

    Sınırı aşan değer `update_params` / `init_config` ve `update_registry_config` / `init_registry_config`'te
    reddedilir (mevcut hata kodları: `InvalidChallengePeriod`, `InvalidDisputeTimeout`, `InvalidScreeningTtl`;
    bond oranı için yeni `InvalidBondBps`).
11. **Keeper ücretinin oranı işin açılışındakidir (P-12):**
    - `Job`'a `keeper_fee_bps: Option<u16>` eklenir; `create_job` config'teki oranı yazar.
    - Finalize, ispatın tazeliği ve escalation (#265) işin oranını kullanır. Alan `None` ise (alandan önce açılmış
      iş) config'tekini.
12. **Fiat işin tutarı (P-14):**
    - `create_fiat_job` tutarın tam sent olmasını ister: `amount % 10^(decimals − 2) == 0`.
    - En az 50 sent: `amount >= 50 × 10^(decimals − 2)` (ADR 0026, Stripe'ın USD alt sınırı).
    - Ondalık, settlement mint hesabından okunur (`address = config.settlement_mint`); hata `InvalidAmount`.
13. **Settlement mint'i (P-17):**
    - `init_config` mint'i yalnızca klasik SPL Token'a aitse ya da uzantısız bir Token-2022 mint'iyse kabul eder.
    - `fund_job` aktarımdan sonra vault'un bakiyesinin `amount` olduğunu denetler.
    - Token programı `Interface` olarak kalır.
14. **Fiat işin escrow talimatlarında reddi (P-16):**
    - Vault isteyen escrow talimatları (`fund_job`, `cancel_job`, `finalize_payment`) fiat işi hesap doğrulamasında
      reddeder: vault yoktur, hata `AccountNotInitialized`'dır. Bu karar ADR 0024'ün hata eşlemesinin yerini alır.
    - Vault istemeyen talimatlar (`list_claim`, `raise_dispute`, `commit_travel_rule`) `RailMismatch` döner
      (bugünkü gibi).
    - `constraints.rs::a_fiat_job_cannot_be_funded` hata kodunu da sabitler.

**Hesap düzeni ve kanıtlar:**

15. **Değişken uzunluklu hesapların yazımı (P-15):**
    - `Job`, `AgentRecord` ve `Institution`'ı yazan her talimat, serileştirilmiş verinin ötesini sıfırlar.
      Yardımcısı `square_common`'dadır.
    - Bu hesaplara alan yalnızca sona ve `Option` olarak eklenir. Sıfırlanmış sonda alan `None` okunur.
    - **Göç:** Upgrade'den önce devnet'teki bu hesaplar salt okunur taranır. Sonu sıfır olmayan hesap varsa göç
      talimatı yazılır, yoksa gerekmez (ADR 0027: yalnızca devnet).
    - Sona alan ekleyen her değişiklikten önce gelir: madde 8, 11, 17 ve ADR 0028'in ret maskesi (#259). ADR
      0028'in "alan gelmeden açılmış işler dolgu baytlarını 0 okur" varsayımı bu maddeyle doğru olur.
16. **Alacak fiyatı (P-18):** `list_claim` `0 < price < amount − keeper ücreti` ister (ücret madde 11'deki oran);
    değilse `InvalidClaimPrice`.
17. **Agent sahipliğinin iki adımla devri (P-13):**
    - `transfer_agent_ownership` bekleyen sahibi yazar.
    - `accept_agent_ownership`'i bekleyen sahip imzalar ve devir tamamlanır. Güncel sahip öneriyi geri çekebilir.
    - `AgentRecord`'a `pending_owner: Option<Pubkey>` eklenir (madde 15'in kuralıyla).
    - SDK devirle birlikte cüzdan güncellemesini ve açık işlerin `sync_agent_wallet`'ını aynı akışta önerir.
18. **İspatın anahtarı (P-06):**
    - `ReleaseProof`'a iki alan eklenir:
      - `vk_version: u16`: bağlamadaki config değeri;
      - `attestor: Pubkey`: fiat işte bağlamadaki `mpp_authority`, escrow rayında sıfır.
    - `record_release` ikisinin de config'in güncel değeriyle aynı olmasını ister; değilse `StaleProof` ve kurum
      yeniden bağlar.
    - Eski boyuttaki ispat bayat sayılır.
    - #196'nın `sync_vk_version`'ıyla birlikte çıkar.
19. **Merkle ağacının alan ayrımı (P-19):**
    - Yaprak `sha256(0x00 ‖ buyer ‖ leaf_salt)`, iç düğüm `sha256(0x01 ‖ min ‖ max)`.
    - Program, `@squaresdk/solana-policy` ve ortak test vektörleri birlikte değişir. Alıcı kanıt dosyası
      `square-buyer-proof` v2 olur.
    - Upgrade'den sonra kurumlar köklerini yeniden yayımlar; eski kanıt dosyaları geçersizdir.

**Sözleşmeler ve dağıtım:**

20. **Sürümler:**
    - Program sözleşmesi her sürümde MINOR artar.
    - API sözleşmesi IDL'den üretilen şemalarla MINOR artar. SDK akışları yeni hesapları kendisi çözer.
    - Devnet'e her sürüm, değişen programların Squads upgrade'iyle çıkar.
21. **Sürümlere bölünme** (önerilen sıra; her biri ayrı PR ve upgrade):

    | Sürüm | Maddeler | Programlar |
    |---|---|---|
    | 1. Hesap yazımı ve tarama | 15, 2, 3, 4, 5, 6 | escrow, registry, policy, `square-common` |
    | 2. Yetki | 1, 8, 9 | escrow, policy, registry, verifier |
    | 3. Parametreler ve tutarlar | 10, 11, 12, 13, 14, 16 | escrow, registry |
    | 4. Hesap alanları ve kanıtlar | 7, 17, 18, 19 | policy, registry, verifier, escrow |

## Gerekçe

Kaynak ([review-bc-39.md](../security/review-bc-39.md)) bulguları ve seçenekleri verir, aralarında seçim yapmaz.
Aşağıdaki gerekçe bu taslağı hazırlayanın değerlendirmesidir; kayıtlı olgulara dayanır.

- **Madde 1:**
  - Policy ve verifier kurumu zaten `Institution::authority()` ile tanır. Escrow'un aynı kaynağı okumasıyla
    kurum yetkisinin programlarda tek tanımı olur.
  - B seçeneği PDA seed'i yüzünden yeni bir alan ve iş başına bir tx ister. C seçeneği teslim edilmiş işi
    korumaz.
  - Paranın da güncel yetkiliye gitmesi gerekir. Yoksa sızmış anahtar iadeleri yine kendi hesabında toplar.
- **Madde 2 ve 5:**
  - ADR 0016'nın kuralı her ödemeye uygulanır. Alımda fiyat satıcıya ödenir; fiat işin ödeme kaydı payee'ye
    yazılır.
  - Fonlama iki tarafı, escrow rayındaki ödeme parayı alan payee'yi tarar. Alım ve fiat kaydı bu kuralın dışında
    kalıyordu.
- **Madde 3:**
  - K1, release'in canlılığını keeper'ların screening kaydına bağlar. ADR 0013 ise finalize'ı herkese açık
    tutar.
  - K2 hem kuralı (taranmamış adrese ödeme yok) hem açıklığı korur. Ücretin kuruma dönmesi, vault fazlasının
    yoluyla aynıdır (ADR 0013 madde 7).
- **Madde 4 ve 6:**
  - Screening'in sorusu "bu kararın verildiği andaki listelere göre" sorusudur. Sıra da kararın anından
    gelmelidir.
  - S2 eşzamanlılığı çözer ama sırayı çözmez. S3 zincir dışı ortak durum ister.
  - Eşitlikte `Flagged`'in kazanması fail-closed kuralının devamıdır ([ADR 0020](0020-sanctions-screening-kaynaklari-ve-saglayici.md) madde 3).
  - Dönem, kararın anı üzerinden aynı ölçüyle işler. Kayda screener yazmak her planlı rotasyonda bütün kayıtları
    düşürürdü.
- **Madde 7:** Satışı kapatmak, kurumun bir politika değişikliğini agent'ın alacağına yansıtır. Kökün
  güncellenmesi ise yalnızca alıcı listesini düzeltir.
- **Madde 8 ve 9:** Bağlanan vault ya da yeni admin, imzasıyla var olduğunu ve doğru türetildiğini kanıtlar. Yanlış
  bir adresle kalıcı kilitlenme olmaz. Admin rotasyonu açılıştaki doğrulamanın aynısıdır.
- **Madde 10 ve 11:**
  - Sınırlar devnet'in değerlerinin üstündedir; bugünkü yapılandırma değişmez.
  - Taşma ve "kimse teslim edemez" durumları açılışta reddedilir.
  - Oranın işe kopyalanması, admin'in açık işlerin netini değiştirmesini ve bağlanmış ispatları bayatlatmasını
    önler.
- **Madde 12 ve 16:** İki kural da zincirdeki işi ödenebilir tutar. Ödenemeyecek iş açılmaz, alıcının alacağının
  değeri ödediğinden az olmaz.
- **Madde 13 ve 14:**
  - Mint config'te sabittir. Tehlikeli uzantılar açılışta reddedilince çalışma anında denetime gerek kalmaz.
  - Fonlamadaki bakiye denetimi beklenmeyen bir uzantıya karşı son kontroldür.
  - P-16'nın reddi bugün güvenli; doğru hata kodu için vault'u isteğe bağlı yapmak bütün istemcilerin hesap
    listesini değiştirirdi.
- **Madde 15:**
  - Sona eklenen her alan bu varsayıma dayanır: madde 8, 11, 17 ve #259.
  - Sıfırlama, yazımı tek bir yardımcıda toplar. Değişken alanları sabit uzunluğa çevirmek ise bütün hesapları
    göçe sokar.
- **Madde 17 ve 18:** İki adımlı devir, imzayla kanıtlanmamış bir adrese kalıcı aktarımı önler. Anahtar ya da
  attestation imzacısı değişince eski anahtarla bağlanmış ispat bekleyemez; tazelik kuralı sürümü de kapsar.
- **Madde 19:** Bugün pratik bir saldırı yok. Ama Square yalnızca devnet'te ve kökler az; standart biçime geçiş
  bugün en ucuz hâlindedir.

## Sonuçlar

- **Uygulama:** Her bulgu kendi issue'sundadır (P-02 – P-19). Sürümlere bölünme madde 21'dedir; sürümün PR'ı
  maddelerinin issue'larını kapatır.
- **İstemciler:**
  - SDK: yeni hesapları çözen akışlar (madde 1, 2, 3, 5, 6, 12); yeni talimatlar (madde 8, 9, 17); Merkle biçimi
    (madde 19).
  - Keeper servisi kendi screening kaydını taze tutar. Kayıt temiz değilse alarm verir.
  - Screener `decided_at`'ı yazar ve `StaleScreeningDecision`'ı ayırır.
  - Web:
    - policy'li işte kurum eylemlerini bağlı cüzdan güncel yetkiliyse açar (FE-21'in vault'u dahil);
    - iki adımlı multisig bağlama ve sahiplik devri;
    - alıcı kanıt dosyası v2.
- **Tx boyutu** ([tx-budget.md](../design/tx-budget.md)):
  - Policy'li `finalize_payment`, madde 1 ve 3'le üç hesap kazanır (`policy`, `policy_institution`, keeper kaydı).
    ALT'sız 1039 bayttan yaklaşık 1138 bayta çıkar (hesap başına 32 bayt anahtar ve 1 bayt indeks). Madde 6'nın
    registry config'i Square ALT'ındadır.
  - 16 kardeşli `buy_claim`, satıcının kaydıyla Square ALT'ında 1198 bayttan yaklaşık 1231 bayta çıkar; sınır
    1232'dir. Uygulamada ölçülür. Sığmazsa en derin liste bir kardeş kısalır. Kayıt cüzdan başına bir PDA olduğu
    için ALT'a konamaz.
- **Belgeler:**
  - program arayüzü §2 (kurum rolü), §4 (okumalar), §5 (Merkle ağacı), §10;
  - ADR 0013, 0014 ve 0024'ün değişen maddelerine bu ADR'ye bağlantı;
  - kısıt matrisi ve threat model;
  - screener runbook'u, upgrade runbook'u ve kurum anahtarının sızıntısı için yeni runbook.

## Açık noktalar

- **Keeper servisi:** Kaydı temiz değilken ücretsiz finalize edip etmeyeceği servisin yapılandırmasıdır
  (`KEEPER_MIN_MARGIN_BPS`).
- **Kabul öncesi ön-ispat (ADR 0028):** `PreflightProof` yalnızca kabulde okunur. VK değişirse ön-ispatın da
  sürümle bağlanıp bağlanmayacağı madde 18'in uygulamasında kesinleşir.
- **Bağlı programlar ve mint (madde 9):** Yanlış bir kimlik bugünkü gibi ancak program upgrade'iyle düzelir.
