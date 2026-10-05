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
| `token::create_usdc_mint`, `create_ata`, `mint_to`, `balance` | Settlement mint'i ve hesapları, SPL Token programının kendi instruction'larıyla |
| `squads::SquadsMultisig` | Squads v4'e ait, `Multisig` discriminator'ıyla başlatılmış hesap ve vault PDA'sı (`square_common::squads`). `Harness::without_sigverify()` + `send_as(ixs, keypairs, pdas)` ile vault imzacı olur |
| `cu::within(label, executed, budget)` | Compute unit'i `[cu] label: N / bütçe` olarak yazar, bütçe aşılırsa testi düşürür |

Squads programının kendisi ortamda yoktur. Square programları Squads'tan yalnızca multisig hesabının
Squads v4'e ait, başlatılmış bir `Multisig` olmasını (sahip + discriminator, `square_common::squads`) ve
işlemi vault PDA'sının imzalamasını bekler. Fikstür bu ikisini kurar; üyeler, eşik ve onaylar Squads'ın
kendi kurallarıdır, burada denenmez.

Compute unit değerleri çalıştırmadan çalıştırmaya değişir: testler rastgele anahtar kullanır ve programlar
PDA bump'ını arar (her ek deneme ~1 500 CU). Bütçeler bu yüzden geniştir; sabit bir CU raporu için sabit
anahtarlar kullanılmalıdır (BC-29).

## Testler (`tests/`)

Dört program da sözleşme arayüzündedir: `square_registry` (BC-15, BC-27), `square_policy` (BC-17, BC-18),
`square_escrow`'un iş yaşam döngüsü (BC-22) ve `square_verifier` (BC-21). Escrow ve verifier testleri
registry ve policy programlarını da yükler; agent kaydı, screening, kurum ve politika programların kendi
instruction'larıyla kurulur (`escrow_world/`). Verifier testlerinin ispatları gerçek Groth16 ispatlarıdır
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
| `finalize.rs` | `finalize_payment`, policy'siz işler: pencere kapanınca herkes kapatır (son saniye ret), keeper ücreti, net ve vault rent'i; çift finalize; keeper agent, kurum ya da rent'i ödeyen sponsor olabilir (`dup`); ücret 0; yanlış payee / keeper / kurum hesabı ve sahte vault; satılmış alacakta alıcıya ödeme, itibarın agent'a yazılması, listelemenin `Settled` olması; payee screening'i işaretli / bayat / yokken bekleme; itibarın işler arasında birikmesi |
| `release_gate.rs` | `finalize_payment`'ın ispat kapısı, gerçek Groth16 ispatlarıyla (`release_world/`): ispat yoksa bekleme; uyumlu ispatla ödeme ve `record_release` CPI'ı (sayaç, ispatın tüketilmesi, validation `Verified`); kesin retta neti kuruma doğru tutarla iade, listelemenin `Defaulted` olması, sayacın ilerlememesi; kategori ve zaman penceresi retlerinde bekleme; başka bir release ve gün dönümünden sonra bayatlama, yeniden bağlama; payee değişince bayatlama; başka job'un ispatı, verifier'a ait olmayan ispat, yanlış sayaç hesabı ve başka program |
| `escrow_lifecycle.rs` | `fund_job`: iki tarafın temiz ve taze screening'i (kayıt yok / işaretli / bayat), başkasının token hesabı, başka mint, Travel Rule eşiği, deadline; fonlanmamış işin kabul edilememesi; kabulü ve teslimi yalnızca job'a bağlı agent cüzdanı yapar (başka imzacı, başka agent'ın kaydı, farklı spec, `Inactive` kabul edemez ama teslim eder, silinmiş kayıt teslim edemez, deadline, URI sınırı), challenge penceresi; `cancel_job`: iade, vault'un kapanıp rent'inin `rent_payer`'a dönmesi, yetkisiz kurum, sahte vault, kabul edilmiş işte deadline, teslim edilmiş işte ret; `sync_agent_wallet`: cüzdan rotasyonunda job'u yalnızca kayıt sahibi taşır |
