# Program güvenlik incelemesi (BC-39)

**Issue:** BC-39 (#93) · **Tarih:** 2026-10-07 · **Commit:** BC-39 PR'ının birleşik commit'i (main `2bd0c80`
üstüne) · **Model:** [program-threat-model.md](program-threat-model.md) · **Hesap kısıtı matrisi:**
[program-constraints.md](program-constraints.md) · **Dış audit paketi:** [audit-package.md](audit-package.md)

**Kapsam:**
- `square_registry`, `square_policy`, `square_verifier`, `square_escrow` (41 talimat);
- ortak crate `square-common`: hesap okuma, screening, Squads, release tazeliği, MPP attestation, Merkle.

Off-chain bileşenler BE-32'dedir ([review-be-32.md](review-be-32.md)). Release devresinin kendisi ve phase-2
töreni BC-38'dedir (#92).

**Kaynak:** Covenant'ın `docs/SECURITY_AUDIT.md`, `docs/AUDIT.md`, `docs/ACCOUNT_CONSTRAINTS_AUDIT.md` ve
`docs/VERIFIABLE_BUILD.md` belgeleri kontrol listesi olarak kullanıldı. Bulgu sınıfları:
- PDA'dan yeniden türetilmeyen token hesabı;
- tarafın kendi alacağını alması ya da kendi işini kabul etmesi;
- bond hesabında mint denetimi ve bond matematiği;
- karar tutarının escrow'u aşması;
- sınırsız config parametreleri;
- elle çözülen hesabın bump'ının ve sahibinin denetlenmemesi;
- taşma denetimi.

Covenant'ın metni kopyalanmadı (LGPL-2.1).

**Yöntem:**
- Talimat başına hesap ve durum kısıtları çıkarıldı. Her kısıtın reddini deneyen negatif test arandı
  ([matris](program-constraints.md)).
- Programlar dört parçada (escrow'un iş yaşam döngüsü, escrow'un settlement ve dispute'u, policy ile registry,
  verifier ile ortak okuyucular) ayrı ayrı incelendi.
- Fon ya da yetkiyle ilgili bulgular LiteSVM'de testle doğrulandı.
- Escrow'un durum makinesi tohumlu fuzz'la denendi ([§4](#4-fuzz-ve-invariant-testi)).

## Sonuç

İç incelemede **kritik bulgu 0**:
- Hesap ikamesiyle ödeme yönlendirme ya da fon çalma yolu bulunmadı.
- Fuzz, hiçbir tohumda değişmez ihlali bulmadı.

Bulguların dağılımı:
- **Yüksek, 1 (P-01):** bir tasarım bulgusu.
- **Orta, 3:** P-02, P-03, P-04.
- **Düşük, 12; bilgi, 5.**

Program kodunu değiştiren her düzeltme sözleşme sürümünü artırır ve devnet'te Squads upgrade'i ister
([runbook](../runbooks/upgrade.md)). Bu yüzden bu PR program kodunu değiştirmez; düzeltmeler ayrı iştir.

Test boşlukları (P-21) bu PR'da kapandı:
- [`constraints.rs`](../../tests/programs/tests/constraints.rs): 10 negatif test;
- [`invariants.rs`](../../tests/programs/tests/invariants.rs): fuzz.

P-02'nin belgeyle çelişen satırı program arayüzünde koda göre düzeltildi. Her bulgu bir issue'dur (#236–#256).

| ID | Önem | Program | Bulgu | Durum |
|---|---|---|---|---|
| [P-01](https://github.com/wienerlabs/square-solana/issues/236) | yüksek | escrow, verifier | Kalıcı ret sebeplerinin parametrelerini (tx tavanı, mint listesi, engelli adresler) kurum iş açılmadan önce, agent'tan gizli seçer. Teslimden sonra geçerli bir kesin ret bağlayıp neti geri alabilir; agent'ın zincirde başvurusu yok | Düzeltildi: kabul öncesi ön-ispat ve public tavan ([ADR 0028](../decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md), program sözleşmesi v0.8.0); devnet'te Squads upgrade'iyle yürürlüğe girer |
| [P-02](https://github.com/wienerlabs/square-solana/issues/237) | orta | policy, escrow | Multisig bağlandıktan sonra, bağlamadan önce açılmış işlerin kurum yetkisi açan anahtarda kalır: sızmış anahtar fonlanmış işi iptal edip iadeyi kendine alır | Açık; program arayüzü belgesi koda göre düzeltildi |
| [P-03](https://github.com/wienerlabs/square-solana/issues/238) | orta | escrow | Alacak satışında satıcı, finalize'da keeper taranmaz: işaretli agent cüzdanı alacağını satıp fiyatı alır | Açık |
| [P-04](https://github.com/wienerlabs/square-solana/issues/239) | orta | registry | Screening kaydında yazım sırası yok: eski bir `Clear` kararı yeni `Flagged` kaydının üstüne yazılıp ömrü yeniler | Açık |
| [P-05](https://github.com/wienerlabs/square-solana/issues/240) | düşük | escrow | Fiat işte payee yalnızca açılışta taranır; cüzdan rotasyonundan sonra taranmamış cüzdana release kaydı | Açık |
| [P-06](https://github.com/wienerlabs/square-solana/issues/241) | düşük | verifier | Bağlanmış ispat, doğrulama anahtarı ya da MPP authority değiştikten sonra da tüketilir | Açık |
| [P-07](https://github.com/wienerlabs/square-solana/issues/242) | düşük | escrow | Yanlış net tutarlı uyumlu bir ispat, agent'ın `escalate_missing_proof`'unu o gün boyunca engeller | Açık |
| [P-08](https://github.com/wienerlabs/square-solana/issues/243) | düşük | policy, escrow | Kapatılan politikanın alıcı kökü değiştirilemez ama açık işlerin `buy_claim`'i onu okumaya devam eder | Açık |
| [P-09](https://github.com/wienerlabs/square-solana/issues/244) | düşük | policy | `set_institution_multisig` yeni vault'un imzasını istemez; yanlış multisig'e bağlama geri alınamaz | Açık |
| [P-10](https://github.com/wienerlabs/square-solana/issues/245) | düşük | registry | Screener rotasyonu eski screener'ın yazdığı kayıtları geçersiz kılmaz | Açık |
| [P-11](https://github.com/wienerlabs/square-solana/issues/246) | düşük | escrow, registry, verifier | Config'in admin'i, bağlı program kimlikleri ve settlement mint'i açılıştan sonra değişmez; upgrade authority değişirse admin eskisinde kalır | Açık |
| [P-12](https://github.com/wienerlabs/square-solana/issues/247) | düşük | escrow, registry | Parametrelerin üst sınırı yok (screening ömrü, `min_bond_bps`, pencere ve süreler); taşmada talimatlar düşer; keeper ücreti açık işlere geriye dönük uygulanır | Açık |
| [P-13](https://github.com/wienerlabs/square-solana/issues/248) | düşük | registry, escrow | Agent sahipliği tek adımda, yeni sahibin kabulü olmadan devredilir; açık işler taşınmaz | Açık |
| [P-14](https://github.com/wienerlabs/square-solana/issues/249) | düşük | escrow | `create_fiat_job` tam sent olmayan ya da 50 sentin altındaki tutarı kabul eder; böyle bir iş ödenemez | Açık |
| [P-15](https://github.com/wienerlabs/square-solana/issues/250) | düşük | escrow | Hesap küçülünce sondaki eski baytlar kalır; `rail`'den sonra eklenecek bir alan (ve BC-37 öncesi işlerde `rail`) eski baytı okur | Açık; mekanizma testle doğrulandı |
| [P-16](https://github.com/wienerlabs/square-solana/issues/251) | bilgi | escrow | `fund_job` ve `cancel_job`'da açık ray denetimi yok; fiat işe `fund_job` ADR 0024'ün `RailMismatch`'i yerine `AccountNotInitialized` döner | Açık |
| [P-17](https://github.com/wienerlabs/square-solana/issues/252) | bilgi | escrow | Token-2022 mint'i kabul edilir; transfer ücreti ve kalıcı delege muhasebeyi bozar; `fund_job` vault'a gelen tutarı denetlemez | Açık |
| [P-18](https://github.com/wienerlabs/square-solana/issues/253) | bilgi | escrow | Alacak fiyatının sınırı keeper ücretini hesaba katmaz; alıcı ödediğinden az alabilir | Açık |
| [P-19](https://github.com/wienerlabs/square-solana/issues/254) | bilgi | square-common | Alıcı listesi Merkle ağacında yaprak ile iç düğüm arasında alan ayrımı yok | Açık |
| [P-20](https://github.com/wienerlabs/square-solana/issues/255) | bilgi | verifier | Sıfır `mpp_authority` yalnızca precompile'ın sıkı doğrulamasıyla reddedilir; açık denetim yok | Açık |
| [P-21](https://github.com/wienerlabs/square-solana/issues/256) | düşük | testler | Güvenlik açısından kritik kısıtların reddi denenmiyordu; kapsam betiği talimat başına "en az bir hata kodu"nu sayar | Düzeltildi: `constraints.rs` (10 test) ve fuzz; kalan boşluklar matristedir |

**Önem ölçeği:**

| Önem | Tanım |
|---|---|
| kritik | Kimliksiz fon kaybı ya da program veya config'in ele geçirilmesi |
| yüksek | Bir tarafın diğerinin fonunu ya da hakkını kural içinde ama karşılıksız alması; uyum kapısının kimliksiz atlanması |
| orta | Belirli bir koşulda (anahtar sızıntısı, yarış) fon ya da yetki kaybı; uyum kapısının atlanması |
| düşük | Sınırlı etki ya da derinlemesine savunma eksiği |
| bilgi | Öneri; bugün etkisi yok |

## 1. Threat model

[program-threat-model.md](program-threat-model.md):
- varlıklar ve zincirde yetki taşıyan anahtarlar;
- aktörler ve saldırgan profilleri;
- güven sınırları (programlar arası okuma, tek CPI, Squads, Ed25519 precompile);
- program başına STRIDE tehditleri, önlemler ve onları deneyen testler;
- kalan riskler.

## 2. Hesap kısıtı denetimi

[program-constraints.md](program-constraints.md): 41 talimatın ana kısıtları ve negatif testleri. Kısıtların çoğu
Anchor'ın bildirimsel kısıtlarıdır:
- `seeds` + kayıtlı bump;
- `has_one`, `address`, token hesabının mint'i ve sahibi;
- programlar arası okumada owner → PDA → discriminator sırası (`square_common::account_read`).

İkame denemeleri BC-29'un `substitution.rs`'indedir.

**Bu PR'da kapatılan boşluklar** ([`constraints.rs`](../../tests/programs/tests/constraints.rs)):
- **Config'in ilk açılışı, üç program:** başka bir programın ProgramData'sı reddedilir. Bu kısıt olmasa
  upgrade authority olmayan ilk çağıran config'i açar:
  - escrow'da bağlı programları ve arbitrator setini seçerdi;
  - verifier'da `record_release`'i çağırabilecek escrow programını seçerdi.
- **`sync_agent_wallet`:** başka kaydın sahibi yabancı işi kendi cüzdanına taşıyamaz (`has_one = agent_record`).
- **Policy:** başka kurumun politikası güncellenemez, kapatılamaz, kökü değiştirilemez (seeds ve `has_one`).
- **`record_screening`:** bir cüzdanın kararı başka cüzdanın kaydına yazılamaz.
- **`cancel_job`:** iade başkasının ya da başka mint'in hesabına gitmez.
- **`accept_job`:** ikinci kabul reddedilir.
- **`buy_claim`:** bir işin listelemesi başka işin alacağı olarak satılamaz.
- **`lapse_dispute`:** son tarihten önce karara bağlanmış dispute düşmez.
- **Fiat ray:** fiat iş fonlanamaz; `create_fiat_job` agent'ın kendi screening kaydını ister.

Kalan boşluklar matriste "Boşluk" olarak listelidir.

**Kapsam betiği:** [`program-coverage.mjs`](../../scripts/ci/program-coverage.mjs) talimat başına en az bir hata
kodunun beklenen hata olarak denetlenmesini sayar. Bu yüzden kritik bir kısıtın reddinin denenmemesi CI'da görünmez
(P-21). Matris bu ölçünün tamamlayıcısıdır. Bugünkü durum:
- dört programda talimat ve ret dalı %100;
- hata kodları: escrow ve policy %100, registry %87,5, verifier %75 (savunma kodları; kapı yalnızca escrow'da).

## 3. Bulgular

### P-01: Kalıcı retlerin parametrelerini kurum işten önce seçer (yüksek)

- **Yer:**
  - `square_common::release::is_final_refusal`;
  - `release_gate.rs` ve `finalize_payment`'in iade dalı;
  - `escalate_missing_proof` (kesin retten sonra başvuru yok).
- **Varsayım:** [ADR 0013](../decisions/0013-release-keeper-ucreti-iade-ve-itibar.md) iadeyi yalnızca kalıcı
  sebeplere bağlar: tx tavanı, mint listesi, engelli adres, sayaç 0 iken günlük tavan. Gerekçesi, kalıcı bitlerin
  kurumun elinde olmamasıdır ve bu iş açıldıktan sonrası için doğrudur.
- **Sorun:** Politikanın gizli parametrelerini (`max_per_tx`, mint listesi, engelli adresler) kurum işten önce
  seçer. Agent `accept_job`'da yalnızca commitment'ı ve public tavanı görür.
- **Senaryo:**
  1. Kurum, `max_per_tx` değeri işin netinden küçük bir politikayla iş açar ve işi fonlar.
  2. Agent işi teslim eder.
  3. Pencere kapanınca kurum geçerli bir kesin ret ispatı bağlar ve finalize eder.
  4. Net kuruma döner.

  Agent'ın elindeki tek hamle alacağı satmaktır. Ama 0, 1 ve 2 bitleri payee'den bağımsızdır; kurum reddi yeniden
  bağlar. Aynı mekanizma, açık alıcı listesindeki ama gizli engelli listedeki bir alacak alıcısına da işler. Bu, ADR
  0013'ün kapatmak istediği Arc #346 sorunudur; iş açılışına taşınmış hâli.
- **Mevcut test:** `release_gate.rs::a_final_refusal_refunds_the_net_to_the_institution` mekanizmayı zaten
  çalıştırıyor (iş "c").
- **Öneri:** Biri seçilmeli:
  - kabulden ya da fonlamadan önce, `(net, mint, agent cüzdanı)` için kalıcı biti olmayan bir ön-ispat şartı;
  - kesin retteki iadeyi agent'ın dispute açabileceği bir pencereye bağlamak.

  Karar bir ADR'dir. En azından agent'ın ve alıcının güven varsayımı belgelenmelidir.
- **Durum: düzeltildi** ([ADR 0028](../decisions/0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 1
  ve 2, program sözleşmesi v0.8.0):
  - Verifier `set_preflight_proof`: kurum, agent kabul etmeden önce işin kendi koşullarıyla (net `job.amount`,
    payee agent cüzdanı, sayaç 0) bir ispat bağlar. Ret kodunda kalıcı bit ya da günlük tavan biti varsa bağlanmaz.
    Escrow `accept_job` policy'li işte (fiat dahil) bu `PreflightProof`'u ister. Ön-ispat bağlamadaki agent
    cüzdanını saklar; cüzdan kabulden önce `sync_agent_wallet` ile taşınırsa kurum yeniden bağlar
    (`preflight.rs::a_wallet_moved_after_the_preflight_needs_a_new_preflight`).
  - `create_job` / `create_fiat_job` public günlük tavanı aşan tutarı reddeder.
  - Commitment iş açılışında sabit olduğu için aynı iş, net ve payee için kalıcı bitler değişmez. Kesin ret yalnızca
    alacak, politikanın gizli engelli listesindeki bir alıcıya satılınca çıkabilir; bu alıcının kendi riskidir
    (alıcı listesi kurumun, engelli listesi gizli). `release_gate.rs::a_final_refusal_refunds_the_net_to_the_institution`
    artık bu yolu çalıştırır; iş "c"nin senaryosu `preflight.rs`'te kabulden önce durur.

### P-02: Multisig'e geçişte açık işlerin yetkisi açan anahtarda kalır (orta)

- **Yer:**
  - escrow `fund_job`, `cancel_job`, `commit_travel_rule`, `raise_dispute` (`has_one = institution`);
  - `Job.institution` işi açan imzacıdır.
- **Senaryo:** Bu PR'da LiteSVM'de doğrulandı.
  1. Kurum anahtarı policy'li bir iş açar ve 250 USDC fonlar.
  2. Anahtar sızar ve kurum multisig bağlar.
  3. Eski anahtar `cancel_job` ile işi iptal eder; 250 USDC eski anahtarın hesabına döner.

  Yeni vault bu işleri yönetemez; ispatı ise yalnızca o bağlayabilir.
- **Belge çelişkisi:** Program arayüzü §2 bağlamadan sonra kurum rolünü "yalnızca vault" olarak tanımlıyordu. Bu
  PR'da satır, bağlamadan önce açılmış işler için koda göre düzeltildi.
- **Öneri:**
  - policy'li işlerde kurum talimatları imzacının `Institution`'ın güncel yetkilisi olmasını istesin, iade de
    güncel yetkiliye yapılsın;
  - ya da `job.institution`'ı güncel yetkiliye taşıyan bir talimat eklensin (`sync_agent_wallet`'ın karşılığı).

  Runbook'a "anahtar sızıntısında önce açık işleri iptal et" adımı eklenmeli.

### P-03: Alacak satışında satıcı taranmaz (orta)

- **Yer:** escrow `buy_claim`, `list_claim`; `finalize_payment`'in keeper ücreti.
- **Sorun:** Screening alıcıda ve release'te payee'de yapılır. Fiyatı alan satıcı (`listing.seller`) ve ücreti
  alan keeper taranmaz. Bu, [ADR 0016](../decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md)'nın "yaptırımlı bir adrese hiçbir
  ödeme yapılmaz" kuralıyla çelişir.
- **Senaryo:**
  1. Agent cüzdanı teslimden sonra `Flagged` olur ve finalize ödemeyi bekletir.
  2. Agent alacağı listeler.
  3. Taranmış bir alıcı alır (alıcı listesi sıfırsa herhangi bir cüzdan).
  4. Fiyat işaretli cüzdana gider.
- **Öneri:**
  - `buy_claim`'e satıcının screening kaydı (`["screening", listing.seller]`) ve `require_clear_screening`
    eklensin; tercihen `list_claim`'e de;
  - keeper da taransın ya da taranmamış keeper'a ücret ödenmesin.

  Bu bir arayüz değişikliğidir.

### P-04: Screening kaydında yazım sırası yok (orta)

- **Yer:** registry `record_screening` (`init_if_needed`, son yazan kazanır; `screened_at` işlemin anıdır).
- **Senaryo:** OFAC listesi güncellenirken aynı cüzdan iki kez taranır (iki screener örneği ya da bir istek ile
  bir yenileme). `Flagged` önce işlenir, eski listeyle verilen `Clear` sonra gelir. Cüzdan bir ömür boyunca
  fonlama, alım ve ödeme kapılarından geçer.
- **Öneri:** Kararın anını ya da bir sıra numarasını argüman olarak alıp saklanandan küçükse reddetmek, ya da
  beklenen önceki `screened_at` ile karşılaştırarak yazmak. Alan eklemek hesap boyutunu değiştirir; mevcut kayıtlar
  için göç gerekir.

### P-05: Fiat işte payee yalnızca açılışta taranır (düşük)

- **Yer:**
  - `create_fiat_job` agent cüzdanını tarar;
  - `sync_agent_wallet` işi taranmamış bir cüzdana taşıyabilir;
  - `finalize_fiat_payment` payee'yi taramadan release ve itibar yazar.
- **Etki:** Fiat para zincirde hareket etmez (ADR 0026, Stripe), ama zincirdeki ödeme kaydı uyum kapısını atlar.
- **Öneri:** `finalize_fiat_payment`'e payee screening'i; ya da fiat işte `sync_agent_wallet` yeni cüzdanın temiz
  olmasını istesin.

### P-06: Bağlanmış ispat anahtar rotasyonundan sonra da tüketilir (düşük)

- **Yer:** `ReleaseProof`'ta doğrulama anahtarı sürümü ya da attestation imzacısı yok; `record_release` ve
  `check_fresh` sürüm denetlemez.
- **Senaryo:** Upgrade'den hemen önce eski anahtarla bağlanmış ispat (ya da sızmış MPP anahtarıyla bağlanmış
  fiat ispatı), tazelik yalnızca gün ve sayaca baktığı için bir sonraki UTC günü boyunca tüketilebilir. BC-38'in
  `sync_vk_version`'ı (#196) config'i günceller, bekleyen ispatları geçersiz kılmaz.
- **Öneri:** `ReleaseProof`'a `vk_version` (MPP için imzacı) yazılsın ve `record_release` güncel sürümü istesin.
  Ya da upgrade runbook'una "upgrade'den sonra bir UTC günü ve 600 s boyunca bekleyen ispatları denetle" adımı
  eklensin.

### P-07: Yanlış net tutarlı ispat escalation'ı engeller (düşük)

- **Yer:** `escalate_missing_proof`'un "bugün işi kapatabilecek ispat var mı" denetimi yalnızca tüketilmeyi, günü
  ve kararı denetler. İspattaki net ise prover'ın beyanıdır.
- **Senaryo:** Kurum net − 1 için geçerli bir uyumlu ispat bağlar. Finalize `StaleReleaseProof` ile bekler,
  escalation da gün boyu `InvalidStatus` döner. Gece yarısına yakın yeniden bağlama engeli ertesi güne taşır.
- **Öneri:** Denetime `net_amount == amount − keeper ücreti` ve `mint == job.mint` eklensin; yeni hesap
  gerekmez.

### P-08: Kapatılan politikanın alıcı kökü donar (düşük)

- **Yer:** policy `set_buyer_root` kapalı politikada reddedilir; escrow `buy_claim` politikanın `active`'ine
  bakmaz.
- **Senaryo:** Kurum politikayı yenisiyle değiştirmek için eskisini kapatır. Listeden çıkarılması gereken bir alıcı,
  eski kanıtıyla açık işlerin alacaklarını almayı sürdürür. Sıfır kök kısıtsız olduğu için "hiç kimse alamaz" da
  ifade edilemez.
- **Öneri:** Kapalı politikada yalnızca kökün güncellenmesine izin verilsin ya da kapalı politikanın işinde satış
  kapansın. Karar ADR 0014'e yazılmalı.

### P-09: Multisig bağlama yeni vault'un imzasını istemez (düşük)

- **Yer:** policy `set_institution_multisig`. Bağlamayı çözen bir yol yok, `owner_key` döndürülemez.
- **Senaryo:** Yanlış multisig adresi, yanlış `vault_index` ya da başkasının multisig'i bağlanırsa kurum kalıcı
  olarak kilitlenir.
- **Öneri:** Yeni vault imzacı olsun (türetilen vault'la eşitliği denetlenir) ya da bağlama iki adımlı olsun
  (öner, kabul et).

### P-10: Screener rotasyonu eski kayıtları geçersiz kılmaz (düşük)

- **Yer:** registry `update_registry_config`. Kayıt onu yazan screener'ı tutmaz; okuyucu config'e bakmaz.
- **Senaryo:** Sızmış screener anahtarıyla yazılmış `Clear` kayıtları, rotasyondan sonra da ömürleri dolana kadar
  geçerli kalır.
- **Öneri:** Kayda screener ya da config'e bir dönem (`min_screened_at`) eklensin ve okuyucuda denetlensin. Kısa
  vadede rotasyondan sonra toplu yeniden tarama runbook'a yazılmalı.

### P-11: Config'in admin'i ve bağlı programları değişmez (düşük)

- **Yer:** `init_config`, `init_registry_config`, `init_verifier_config`.
- **Sorun:** Admin, bağlı program kimlikleri ve settlement mint'i yalnızca açılışta yazılır. Güncelleme talimatları
  yalnızca saklanan admin'i denetler.
- **Senaryo:** Upgrade authority vault'u değişirse (ADR 0008) config'leri yalnızca eski vault yönetir. Yanlış bir
  program kimliği ancak program upgrade'iyle düzelir.
- **Öneri:** Güncel upgrade authority'yle doğrulanan bir admin rotasyonu talimatı.

### P-12: Parametrelerin üst sınırı yok (düşük)

- **Yer:** escrow `validate_params`, registry `validate_screening_ttl`.
- **Sınırsız parametreler:**
  - `min_bond_bps` 10 000'i aşabilir;
  - `max_challenge_period` i64'e yakınsa `submit_work`'ün pencere hesabı taşar ve agent teslim edemez;
  - screening ömrü i64'e yakınsa `record_screening` taşar ve kimse işaretlenemez;
  - ispat ve dispute süreleri.
- **Geriye dönük etki:** `keeper_fee_bps` değişikliği açık işlere uygulanır ve bağlanmış ispatları bayatlatır.
- **Öneri:** Üst sınırlar; ücret oranını job'a kopyalamak.

### P-13: Agent sahipliği tek adımda devredilir (düşük)

- **Yer:** registry `transfer_agent_ownership`; escrow `sync_agent_wallet`.
- **Sorun:** Yeni sahibin kabulü yok. Yanlış adrese devirde kayıt, itibar ve did:aip kimliği kalıcı olarak gider.
- **Açık işler:** Devir açık işleri taşımaz. Eski cüzdan `sync_agent_wallet` çağrılana kadar işi kabul edebilir,
  teslim edebilir ve alacağı satabilir.
- **Öneri:** Bekleyen sahip ve kabul adımı; SDK devri aynı işlemde senkronlamayla önersin.

### P-14: Fiat işin tutarı zincirde denetlenmez (düşük)

- **Yer:** `create_fiat_job` yalnızca `amount > 0` ister.
- **Senaryo:** API tam sent olmayan ya da 50 sentin altındaki tutarı reddeder (ADR 0026). Böyle bir iş kabul
  edilip teslim edilir ama ödenemez, zincirde de çaresi yoktur.
- **Öneri:** Mint'in ondalığıyla sent kuralı ve alt sınır.

### P-15: Küçülen hesabın sonunda eski baytlar kalır (düşük)

- **Yer:** Anchor hesabı yazarken sondaki baytları sıfırlamaz. `Job`'un `rail` alanı değişken uzunluklu
  alanlardan sonra eklenmiştir.
- **Doğrulama:** Bu PR'da LiteSVM'de denendi. Split oyu ve set değişiminden sonra karar 9 bayttan 1 bayta küçülür.
  Hesabın sonunda eski teslimat URI'sinin 8 baytı kalır.
- **Etki:**
  - `rail`'den sonra eklenecek bir alan, yeniden yazılmamış hesapta bu baytları okur.
  - BC-37'den önce açılıp bu geçmişi yaşamış bir işte `rail` de eski bayttır: geçersizse iş çözülemez ve kilitlenir,
    `0x01` ise fiat sanılır.
- **Öneri:** Alan eklemeden önce sürümlü göç (realloc ve yeniden yazım) ya da yazımdan sonra sonu sıfırlamak.

### P-16 – P-20 (bilgi)

- **P-16:** `fund_job` ve `cancel_job` (ve finalize, alım, oy, karar, lapse) ray denetlemez. Bugün güvenli: fiat
  işin vault'u hiç açılamaz. Fiat işe `fund_job` ADR 0024'ün `RailMismatch`'i yerine `AccountNotInitialized`
  döner. Açık `rail == Escrow` kısıtı önerilir. `constraints.rs::a_fiat_job_cannot_be_funded` reddi sabitler.
- **P-17:**
  - **Sorun:** Token programı `Interface` ile Token-2022'yi de kabul eder. Transfer ücretli bir mint'te vault
    `amount`'tan az tutar ve tutulan ücret vault'un kapanmasını engeller; kalıcı delege uzantısı vault'u
    boşaltabilir.
  - **Neden bilgi:** Mint config'te sabittir ve admin'in seçimidir (program arayüzü §8).
  - **Öneri:** `Program<Token>` ya da açılışta mint uzantısı denetimi; `fund_job`'da vault'un aldığı tutarın
    denetimi.
- **P-18:** `list_claim` fiyatın yüz değerden küçük olmasını ister, keeper ücretini değil. `[amount − ücret, amount)`
  aralığında alan alıcı ödediğinden az alır. Öneri: `fiyat < amount − ücret`.
- **P-19:** Merkle ağacında yaprak ve iç düğüm aynı biçimde hash'lenir. Alıcı imzacı olduğu için ikinci ön-görüntü
  pratik değil. SDK ile birlikte `0x00`/`0x01` önekleri önerilir.
- **P-20:** Fiat rayını kapatmak için verilen sıfır `mpp_authority` yalnızca Ed25519 precompile'ın sıkı
  doğrulamasıyla reddedilir. Açık bir `!= Pubkey::default()` denetimi önerilir.

### P-21: Kritik kısıtların negatif testi yoktu (düşük, düzeltildi)

[§2](#2-hesap-kısıtı-denetimi)'deki 10 test ve fuzz. Kalan boşluklar matristedir ve bir programın kodunu
değiştirmeden eklenebilir.

## 4. Fuzz ve invariant testi

[`tests/programs/tests/invariants.rs`](../../tests/programs/tests/invariants.rs) escrow'un durum makinesinde tohumlu
rastgele işlem dizileri koşar:
- **Ortam:** policy'siz işler; iki kurum, iki agent, iki alıcı, iki keeper ve bir saldırgan.
- **Seçim:** Adımların dörtte üçü seçilen işin durumuna uygun bir işlemdir ve fuzz durum makinesinin derin
  kenarlarına ulaşır. Dörtte biri herhangi bir işte herhangi bir işlemdir: yanlış durumda, yetkisiz imzacıyla,
  saldırganın token hesabıyla ve sınırın dışındaki değerlerle.
- **İşlemler:**
  - iş açma, fonlama, kabul, teslim, iptal;
  - alacak listeleme, alım, geri çekme;
  - finalize;
  - bond'lu dispute, oy, karar yürütme, lapse;
  - arbitrator seti değişimi;
  - vault'a ya da bond vault'una bağış;
  - screening değişimi;
  - pencere, son tarih ve dispute son tarihinin sınırlarına zaman atlaması.

Her adımdan sonra denetlenen invariant'lar:

1. **Bakiye modeli:**
   - Başarılı işlemde her izlenen token hesabının farkı kuralın beklediği farktır: net, keeper ücreti
     (≤ %1, aşağı yuvarlanır), iade, karar tutarı, bond'un tek tarafa gitmesi, vault'taki fazlanın kuruma dönmesi.
   - Başarısız işlemde hiçbir bakiye değişmez.
2. **Korunum:** İzlenen hesapların toplamı basılan miktara eşittir.
3. **Escrow'un ödeme gücü:** Fonlanmış işin vault'u `amount`'tan az tutmaz; kapanan işin vault'u kalmaz.
4. **Bond'un ödeme gücü:** Bond'lu açık dispute'un bond vault'u bond'dan az tutmaz; dispute kapanınca bond vault'u
   kalmaz.
5. **Durum makinesi:**
   - Geçişler yalnızca izinli kenarlardandır.
   - İş başına bir dispute açılır.
   - Ödemede listeleme `Settled`, iadede `Defaulted` olur.
   - Listeleme fiyatı yüz değerin altındadır.
6. **Saldırgan:** Saldırganın bakiyesi hiçbir adımda artmaz.

**Koşu:** CI'da `anchor test` adımında 16 tohum × 120 adım (~12 sn, debug derleme). Her işlem en az bir kez
başarıyla koşar; test aksi hâlde düşer. Ayarlar ortam değişkenleridir:

```bash
SQUARE_FUZZ_SEEDS=64 SQUARE_FUZZ_STEPS=400 cargo test --locked --manifest-path tests/programs/Cargo.toml --test invariants -- --nocapture
SQUARE_FUZZ_SEED=7 cargo test --locked --manifest-path tests/programs/Cargo.toml --test invariants -- --nocapture
```

Düşen bir tohum, tohum numarasını, adımı ve son 25 adımın günlüğünü yazar. `--nocapture` ile işlem başına başarı ve
ret kodu sayıları yazılır.

**Denetleyicinin denetimi:** Modeldeki keeper ücreti bir birim kaydırıldığında test 1. tohumun 20. adımında düştü.

**Sonuç:** Hiçbir tohumda invariant ihlali yok. Policy'li işlerin ispat kapısı gerçek Groth16 ispatı ister; o
dallar `release_gate.rs` ve `dispute_gate.rs`'teki deterministik testlerdedir.

## 5. Verifiable build

Programların verifiable build'i BC-13'tedir ([docs/ci.md](../ci.md#verifiable-build)):
- **Araçlar:** `Verifiable build` iş akışı programları Docker'da sabit imajla derler:
  `solanafoundation/solana-verifiable-build:4.1.2` (digest ile) ve solana-verify 0.5.2 (SHA-256 ile).
- **Çıktılar:** Executable hash'leri iş özetine ve artefakta yazılır.
- **Devnet karşılaştırması:** Elle tetiklendiğinde (`rpc_url`) zincirdeki hash'lerle karşılaştırılır.
- **Kayıt:** Devnet deploy'larının ve upgrade'lerinin hash'leri ve kaynak commit'leri
  [devnet kaydında](../deploy/devnet.md).

İş akışının son başarılı koşusu 2026-10-05'tedir (main `dbf7254`). O tarihten beri Actions'ın işleri ödeme kısıtı
yüzünden başlamıyor ([docs/ci.md](../ci.md#merge-kuralı)). Devnet'teki programlar sonraki commit'lerden
deploy edildi.

**Zincir ve kayıt (bu PR, 2026-10-07):** Dört programın ProgramData'sı devnet'ten okundu (`getAccountInfo`, salt
okuma). Hash solana-verify'ın yöntemiyle hesaplandı: 45 baytlık başlıktan sonraki baytlar, sondaki sıfırlar
atılarak SHA-256'dan geçirildi.

| Program | Zincirdeki executable hash | Son deploy slot'u | Kayıttaki kaynak |
|---|---|---|---|
| `square_registry` | `8b5781c0f35756675df2373b5ea97547c3e39809af7de8363aea5636d73b2580` | 508076000 | `4509884`, BC-30 |
| `square_policy` | `22d6dbd59527d98529016c8e8ae721d54466893c6730fc3bbf69641d68b8c12b` | 508076079 | `4509884`, BC-30 |
| `square_verifier` | `d7ec6985f645ad7eb57faf98d8c559bb5f9e0602e22d464e8389405a47faab52` | 508252508 | `0dcb71e`, BC-37 |
| `square_escrow` | `10ede5234f421c2dcb109cb4a04466b82db36d6b5999ef44d4bbcdc5c8825e16` | 508253095 | `0dcb71e`, BC-37 |

Sonuç:
- Dört hash ve slot'lar devnet kaydındakilerle aynı; kayda geçmemiş bir upgrade yok.
- Dört programın upgrade authority'si kayıttaki 2-of-3 Squads vault'u (`J73BpSow…`).

**Kaynaktan yeniden üretim:** Kayıttaki hash'lerin commit'lerden yeniden derlenmesi bu incelemede yapılmadı. İmaj
amd64'tür; yerel Docker ortamı arm64. Actions açılınca iş akışıyla yapılır:
- **verifier ve escrow:** main'deki kaynakları `0dcb71e`'dekiyle aynı; iş akışı main'de tetiklenir.
- **registry ve policy:** `4509884`'ten sonra `square-common`'a MPP modülü eklendi; iş akışı `4509884`'te tetiklenir.

Sonuç devnet kaydına yazılır.

## 6. Sonraki adımlar

- Açık bulguların düzeltmeleri. Her biri program kodunu ve çoğu sözleşmeyi değiştirir, devnet'te Squads upgrade'i
  ister.
- P-04 önce karar ister (ADR). P-01'in kararı ADR 0028'dir ve düzeltildi.
- Dış audit: firma ve kapsam BC-40 (#96), yürütme BC-41 (#97). Paket: [audit-package.md](audit-package.md).
