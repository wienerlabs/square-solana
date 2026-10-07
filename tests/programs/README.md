# tests/programs — program testleri (LiteSVM)

Dört programın testleri [LiteSVM](https://github.com/LiteSVM/litesvm) üzerinde koşar. LiteSVM, Agave'nin
SBF çalışma zamanını süreç içinde çalıştırır: `anchor build`'in ürettiği `target/deploy/*.so` dosyaları
yüklenir, validator gerekmez, testler milisaniyeler sürer. Instruction'lar ve hesaplar programların kendi
crate'lerinden (`no-entrypoint`) kurulur; program arayüzü değişince testler derlenmez.

Bu dizin kendi Cargo workspace'idir ve kendi `Cargo.lock`'u vardır. Böylece test araçlarının bağımlılıkları
(litesvm, Agave çalışma zamanı crate'leri) deploy edilen programların kök `Cargo.lock`'taki çözümünü
değiştirmez.

## Çalıştırma

```bash
anchor build                                            # target/deploy/*.so
anchor test --validator legacy --skip-build             # Anchor.toml test betiği: aşağıdaki cargo test
cargo test --locked --manifest-path tests/programs/Cargo.toml -- --nocapture
```

Araç sürümleri `Anchor.toml [toolchain]`'deki gibi: Anchor 1.2.0, Agave 4.1.2 (ADR 0007). Anchor 1.2'nin
`anchor test`'i varsayılan olarak Surfpool başlatır; `--validator legacy` `solana-test-validator`'ı seçer.
LiteSVM testleri validator'ı kullanmaz. `.so` başka bir dizindeyse `SBF_OUT_DIR` ile verilir. CI:
[`.github/workflows/programs.yml`](../../.github/workflows/programs.yml).

## Harness (`src/`)

| Parça | Ne yapar |
|---|---|
| `Harness::new()` | Ortam: SPL Token, Token-2022 ve ATA programları yüklü, fonlanmış bir `payer` |
| `deploy(name, id)` | `target/deploy/<name>.so`'yu programın `declare_id!` adresine yükler |
| `deploy_upgradeable(name, id, authority)` | Yükseltilebilir loader'la, `authority` yükseltme yetkilisi olarak (ör. escrow `init_config` bunu `ProgramData`'dan doğrular) |
| `send(ixs, signers)` | Taze blockhash'le gönderir; `Executed { compute_units, logs }` ya da `Failed { error, logs, compute_units }` |
| `Failed::assert_error(code)`, `anchor_error(E)` | Anchor hata kodunu (6000 + sıra) programın kendi hata enum'undan karşılaştırır |
| `account::<T>(address)` | Anchor hesabını discriminator denetimiyle çözer |
| `event::<E>(executed)`, `events::<E>` | İşlem loglarındaki `Program data:` satırlarından Anchor event'lerini (`emit!`) çözer |
| `now()`, `set_time(t)`, `advance(seconds)` | Clock sysvar'ı: challenge penceresi, deadline, UTC gün sınırı |
| `token::create_usdc_mint`, `create_ata`, `create_token_account`, `mint_to`, `balance` | Settlement mint'i ve hesapları (ATA ve ATA olmayan token hesabı), SPL Token programının kendi instruction'larıyla |
| `squads::SquadsMultisig` | Squads v4'e ait, `Multisig` discriminator'ıyla başlatılmış hesap ve vault PDA'sı (`square_common::squads`). `Harness::without_sigverify()` + `send_as(ixs, keypairs, pdas)` ile vault imzacı olur |
| `cu::within(label, executed, budget)` | Compute unit'i `[cu] label: N / bütçe` olarak yazar, bütçe aşılırsa testi düşürür |
| `v0_transaction(ixs, signers, tables)`, `send_transaction(tx)`, `create_lookup_table(addresses)`, `wire_size(tx)` | v0 işlemi (ALT'lı ya da ALT'sız), address lookup table'ı ALT programının talimatlarıyla kurmak, işlemin tel boyutu (`PACKET_DATA_SIZE` = 1232) (BC-28) |

Squads programının kendisi ortamda yoktur. Square programları Squads'tan yalnızca multisig hesabının
Squads v4'e ait, başlatılmış bir `Multisig` olmasını (sahip + discriminator, `square_common::squads`) ve
işlemi vault PDA'sının imzalamasını bekler. Fikstür bu ikisini kurar; üyeler, eşik ve onaylar Squads'ın
kendi kurallarıdır, burada denenmez.

Compute unit değerleri çalıştırmadan çalıştırmaya değişir: testler rastgele anahtar kullanır ve programlar
PDA bump'ını arar (her ek deneme ~1 500 CU). Bütçeler bu yüzden geniştir. CU raporu (aşağıda) bir koşunun
ölçümüdür; denetim bütçelerdedir.

## Testler (`tests/`)

Dört program da sözleşme arayüzündedir: `square_registry` (BC-15, BC-27), `square_policy` (BC-17, BC-18),
`square_escrow`'un iş yaşam döngüsü (BC-22), alacak piyasası (BC-25) ve release'i (BC-23, BC-24, BC-26) ve
`square_verifier` (BC-21). Escrow ve verifier testleri registry ve policy programlarını da yükler; agent
kaydı, screening, kurum, politika, alıcı listesi ve alacak satışı programların kendi instruction'larıyla
kurulur (`escrow_world/`). Verifier testlerinin ispatları gerçek Groth16 ispatlarıdır
(`fixtures/release-proofs.json`): `circuits/payment-compliance/scripts/program-proofs.mjs` devrenin test
dünyasında üretir, testler kurumu, agent cüzdanını ve mint'i aynı etiketlerden türetir. Devre CI'ı
fikstürdeki her ispatı doğrulama anahtarına ve yeniden hesaplanan sinyallere karşı denetler.

| Dosya | Kapsam |
|---|---|
| `registry.rs` | Kayıt, kart / hash, durum, devir, kalıcı kayıt silme, event'ler, Squads vault'u sahip olarak |
| `screening.rs` | Registry config'ini yalnızca yükseltme yetkilisinin kurması; screening kaydını yalnızca screener'ın yazması, üzerine yazma, screener ve ömür rotasyonu; escrow okumasının (`square_common::screening`) programın yazdığı hesapla temiz / bayat / işaretli / başka cüzdan ayrımı |
| `policy.rs` | Kurum ve politika commitment'ı (yalnızca commitment ve public tavan, sabit hesap boyutu, event'ler); her güncellemede sürüm artışı; kapalı politikanın güncellenmemesi; tavan 0, uzun ad ve yabancı imzacı reddi; Squads'a ait olmayan, `Multisig` olmayan ya da argümanla uyuşmayan hesabın reddi; multisig bağlanınca yalnızca vault PDA'sının yetkili olması, vault'un yeniden bağlaması ve eski vault'un reddi; alıcı listesi kökü (BC-18): yalnızca güncel yetkili yayımlar, kapalı politikada ret, `BuyerRootCommitted` ve yayımlanan köke karşı kanıt doğrulaması |
| `verifier.rs` | Config'i yalnızca yükseltme yetkilisinin kurması; geçerli ispatın `ReleaseProof` yazması (alanlar, sayaç, event, CU); ret ispatının sebebiyle yazılıp yeniden bağlanabilmesi; başka payee, mint, politika, job, net, ret kodu ya da an için yapılmış ve bozulmuş ispatın, cüzdan rotasyonundan sonra eski payee'nin ispatının reddi; yalnızca kurumun yetkilisinin kendi politikalı işine bağlaması; teslim edilmemiş işe ve saat toleransı dışında bağlanamaması; satılmış alacakta payee'nin alıcı olması; `record_release`'i yalnızca escrow'un PDA'sının çağırması, sayacın ilerlemesi, başka bir release'ten ve gün dönümünden sonra bayatlama (`square_common::release::check_fresh` ve verifier), tüketilmiş ispat, ret release'inin sayacı ilerletmemesi |
| `escrow.rs` | Config'i yalnızca yükseltme yetkilisinin kurması ve parametre / arbitrator seti doğrulaması; `update_params`'ı yalnızca admin; `create_job`: rent'i rol imzacısından ayrı `payer` öder, iş kayıtlı ve `Active` agent'a bağlanır (registry'ye ait olmayan, `Inactive`, silinmiş kayıt reddi), policy anlık görüntüsü, policy'nin ve kurumunun owner / PDA / yetkili / etkinlik denetimi, Squads vault'u kurum olarak, tek settlement mint'i, sahte vault reddi |
| `travel_rule.rs` | Travel Rule commitment'ı (ADR 0015): `Open` işe bağlama, event, fonlamaya kadar düzeltme ve fonlamadan sonra değişmeme; eşiğe eşit tutarda commitment'sız fonlama reddi, eşiğin altı ve kapalı eşik; başka kurum ve sıfır commitment; talimat verisinin 32 bayt commitment'tan ibaret olması, kaydın alanlarının hesapta ve loglarda olmaması, commitment'ın kayıt ve salt'la doğrulanması |
| `claim.rs` | Alacak piyasası (ADR 0014): listeleme (yalnızca agent cüzdanı, teslim edilmiş iş, yüz değerin altında, job başına tek), onaylı listedeki alıcının alımı (fiyat satıcıya, event'ler, listeleme `Bought`), ikinci alımın ve satılmış listelemenin geri çekilmesinin reddi; kopya kanıt, yanlış salt, eksik ve 16'dan uzun kanıt; kurum listeyi değiştirince güncel köke göre değerlendirme; sıfır kök ve policy'siz işte kısıtsız alım, policy hesabının job'unki olması; fiyat değişimi, satıcı (aynı ATA ve ikinci token hesabı) ve kurum alıcı olarak, alıcı screening'i yok / işaretli / bayat, satıcının olmayan token hesabı; cüzdan rotasyonundan sonra eski listelemenin satılamaması; sponsorun rent'i geri alması, yabancı imzacı ve yanlış rent alıcısı, yeniden listeleme; ödemede satılmamış listelemenin kapanması; 16 kardeşli en derin listenin tek işlemde CU'su |
| `finalize.rs` | `finalize_payment`, policy'siz işler: pencere kapanınca herkes kapatır (son saniye ret), keeper ücreti, net ve vault rent'i; çift finalize; keeper agent, kurum ya da rent'i ödeyen sponsor olabilir (`dup`); ücret 0; yanlış payee / keeper / kurum hesabı ve sahte vault; satılmış alacakta (gerçek `list_claim` / `buy_claim`) alıcıya ödeme, itibarın agent'a yazılması, listelemenin `Settled` olması; payee screening'i işaretli / bayat iken ve alıcı satın aldıktan sonra işaretlenince bekleme; itibarın işler arasında birikmesi |
| `release_gate.rs` | `finalize_payment`'ın ispat kapısı, gerçek Groth16 ispatlarıyla (`release_world/`): ispat yoksa bekleme; uyumlu ispatla ödeme ve `record_release` CPI'ı (sayaç, ispatın tüketilmesi, validation `Verified`); kesin retta neti kuruma doğru tutarla iade, listelemenin `Defaulted` olması, sayacın ilerlememesi; kategori ve zaman penceresi retlerinde bekleme; başka bir release ve gün dönümünden sonra bayatlama, yeniden bağlama; payee değişince bayatlama; başka job'un ispatı, verifier'a ait olmayan ispat, yanlış sayaç hesabı ve başka program |
| `dispute.rs` | Uyuşmazlık, policy'siz işler (BC-32, BC-33; ADR 0016): kurumun pencere içinde yeterli bond'la itirazı (bond alt sınırı, kurum dışı imzacı, teslim edilmemiş iş, kapanmış pencere, ikinci dispute); M-of-N oy (panel dışı imzacı, `Pending` ve escrow'u aşan Split oyu, aynı arbitrator'ın ikinci oyu, farklı karar, eşikte `Resolved`, karardan sonra oy yok); `execute_resolution` FavorAgent (tutarın tamamı ve bond agent'a, vault'lar kapanır, rent), FavorInstitution (iade ve bond, `NoPayout`, payee screening'i aranmaz), Split; payee'nin hesabı ve screening'i; satılmış alacakta alıcıya ödeme ve iadede `Defaulted`; son tarihten önce lapse reddi, son tarihte oy reddi, lapse'ta bond iadesi, ikinci dispute yasağı ve normal finalize; M-of-N set kuralları (`init_config`, `update_arbitrators`, yalnızca admin); aktif dispute'ta set değişiminde sayımın yeni setle baştan başlaması; dispute ve ispat sürelerinin doğrulaması |
| `dispute_gate.rs` | Policy'li işte uyuşmazlık, gerçek Groth16 ispatlarıyla: karar sonrası (`Resolved`) bağlanan ispatla FavorAgent'ta tam tutar (ispat yok, keeper ücretli net bayat), Split'te pay ispatı, kesin retta iade ve bond'un ceza olarak agent tarafına kesilmesi; `escalate_missing_proof`: policy'siz iş, bekleme süresi, yalnızca agent, bond'suz dispute, lapse ve süre dolunca tekrar, FavorInstitution; bugün işi kapatabilecek uyumlu ispat varken ret, geçici retle ve başka günün ispatıyla başvuru |
| `substitution.rs` | Hesap ikamesi (BC-29): `finalize_payment`'e başka işin alacak listelemesi ve başka rent alıcısı; escrow'a ait olmayan job kopyası; `execute_resolution`'a başka işin vault'u, bond vault'u, listelemesi ve validation kaydı, başkasının kurum hesabı, başka mint, başka rent alıcısı; bond'lu dispute'ta bond vault'unun verilmemesi (`execute_resolution`, `lapse_dispute`); `lapse_dispute`'a başka işin bond vault'u; başka kurumun işine ve başkasının hesabından itiraz, sahte bond vault'u. Her denemede diğer iş etkilenmez |
| `squads.rs` | Squads smart account ve sponsorlu ücret (BC-35): akışın sekiz adımı, kurum, agent ve alıcı rollerinde Squads v4 vault PDA'larıyla; ücreti ve rent'i rolü olmayan sponsor öder, vault'lar SOL harcamaz; gerçek Groth16 ispatıyla alıcı vault'una ödeme (`fixtures/squads-proofs.json`). Sponsor kurumun politikasını yazamaz, işi fonlayamaz, kabul edemez; vault rent'i başka hesaba yönlendirilemez. Yükseltme yetkilisi vault olan üç programın config'i vault imzasıyla ve vault'un SOL'üyle kurulur |
| `tx_budget.rs` | İşlem bütçesi (BC-28): 8 adımın her tx'i SDK'nın biçiminde ve en kötü durumuyla (en uzun alanlar, 16 kardeşli kanıt, açılacak ATA'lar, gerçek ispat ve `record_release` CPI'ı) ALT'sız ve Square ALT'ıyla ölçülür. Square ALT'ıyla her tx pakete sığar, ölçülen CU profil sınırının %75'ini aşmaz; sınırlar ve ALT içeriği `packages/sdk/src/tx-profile.json`'dan. `-- --nocapture` tabloyu yazar ([tx-budget.md](../../docs/design/tx-budget.md)) |
| `escrow_lifecycle.rs` | `fund_job`: iki tarafın temiz ve taze screening'i (kayıt yok / işaretli / bayat), başkasının token hesabı, başka mint, Travel Rule eşiği, deadline; fonlanmamış işin kabul edilememesi; kabulü ve teslimi yalnızca job'a bağlı agent cüzdanı yapar (başka imzacı, başka agent'ın kaydı, farklı spec, `Inactive` kabul edemez ama teslim eder, silinmiş kayıt teslim edemez, deadline, URI sınırı), challenge penceresi; `cancel_job`: iade, vault'un kapanıp rent'inin `rent_payer`'a dönmesi, yetkisiz kurum, sahte vault, kabul edilmiş işte deadline, teslim edilmiş işte ret; `sync_agent_wallet`: cüzdan rotasyonunda job'u yalnızca kayıt sahibi taşır |
| `constraints.rs` | Hesap kısıtı denetiminin kapattığı negatif testler (BC-39, [program-constraints.md](../../docs/security/program-constraints.md)): üç config'in açılışında başka programın ProgramData'sı; `sync_agent_wallet`'ta başka kaydın sahibi; başka kurumun politikası; başka cüzdanın screening kaydı; `cancel_job`'da başkasının ya da başka mint'in hesabı; ikinci kabul; başka işin listelemesi; karara bağlanmış dispute'un lapse'ı; fiat işin fonlanması ve agent'ın kendi screening kaydı |
| `invariants.rs` | Escrow'un durum makinesinde tohumlu fuzz (BC-39, [review-bc-39.md §4](../../docs/security/review-bc-39.md#4-fuzz-ve-invariant-testi)): rastgele işlem dizileri, yetkisiz ve sınır dışı denemeler, vault'a bağış; her adımdan sonra bakiye modeli, korunum, escrow ve bond'un ödeme gücü, durum makinesi ve saldırganın bakiyesi. `SQUARE_FUZZ_SEEDS` (varsayılan 16), `SQUARE_FUZZ_STEPS` (120); düşen tohum `SQUARE_FUZZ_SEED` ile yeniden koşar |

## Kapsam ve CU raporu (BC-29)

Programlar SBF olarak koştuğu için satır kapsamı ölçülmez; kapsam sözleşmenin yüzeyine göre ölçülür
([`scripts/ci/program-coverage.mjs`](../../scripts/ci/program-coverage.mjs)):

- **talimat:** talimatın builder'ı testlerde kullanılıyor;
- **ret dalı:** talimatın kaynağında ve kullandığı modüllerde geçen hata kodlarından en az biri beklenen hata
  olarak denetleniyor;
- **hata kodu:** sözleşmenin her kodu beklenen hata olarak denetleniyor; testle tetiklenemeyen savunma kodları
  gerekçesiyle betikte listelenir ve paydadan düşer (`MathOverflow`, seed kısıtının arkasındaki
  `ClaimListingMismatch`).

`square_escrow` için her oran en az %80 olmalıdır; CI'da `Programs` iş akışının "Program test kapsamı" adımı
düşürür. Diğer programlar raporlanır. Bugünkü durum:

| Program | Talimat | Ret dalı | Hata kodu |
|---|---|---|---|
| square_escrow (kapı) | 22/22 | 100% | 48/48 ulaşılabilir (2 savunma kodu) |
| square_policy | 6/6 | 100% | 5/5 |
| square_registry | 8/8 | 100% | 7/8 (`AgentInactive`) |
| square_verifier | 5/5 | 100% | 9/12 (`SnapshotMismatch`, `PayeeMismatch`, `MintMismatch`) |

CU raporu: `cargo test --manifest-path tests/programs/Cargo.toml -- --nocapture | tee cu.log` ve
`node scripts/ci/cu-report.mjs cu.log`. CI raporu iş özetine yazar. Escrow'un 2026-10-06 ölçümü
(LiteSVM, Agave 4.1.2):

| Talimat | CU | Bütçe |
|---|---:|---:|
| `create_job` / policy'li | 24 423 / 32 334 | 40 000 / 50 000 |
| `commit_travel_rule` | 6 219 | 10 000 |
| `fund_job` | 29 140 | 50 000 |
| `accept_job` / `submit_work` | 7 505 / 8 002 | 20 000 |
| `cancel_job` | 15 404 | 30 000 |
| `list_claim` / `cancel_claim` | 10 992 / 4 304 | 25 000 / 10 000 |
| `buy_claim` (3 alıcılı / 16 seviyeli liste) | 29 652 / 23 507 | 40 000 |
| `finalize_payment` gate'siz / uyumlu ispat ve CPI | 50 497 / 75 656 | 80 000 / 150 000 |
| `raise_dispute` | 23 846 | 60 000 |
| `resolve_dispute` | 9 436 | 30 000 |
| `execute_resolution` gate'siz / ispat kapısı | 58 864 / 81 024 | 90 000 / 140 000 |
| `lapse_dispute` | 18 472 | 40 000 |
| `escalate_missing_proof` | 11 723 | 30 000 |
