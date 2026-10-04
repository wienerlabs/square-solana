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

`square_policy` sözleşme arayüzündedir (BC-17). Diğerleri henüz kaynak projelerin arayüzündedir (AIP
registry, Aperture verifier, Covenant escrow); sözleşmeye (`idl/`) taşındıkça testleri de taşınır: BC-15,
BC-21, BC-22.

| Dosya | Kapsam |
|---|---|
| `registry.rs` | Kayıt, çift kayıt, sahiplik kısıtı, uzunluk sınırları |
| `policy.rs` | Kurum ve politika commitment'ı (yalnızca commitment ve public tavan, sabit hesap boyutu, event'ler); her güncellemede sürüm artışı; kapalı politikanın güncellenmemesi; tavan 0, uzun ad ve yabancı imzacı reddi; Squads'a ait olmayan, `Multisig` olmayan ya da argümanla uyuşmayan hesabın reddi; multisig bağlanınca yalnızca vault PDA'sının yetkili olması, vault'un yeniden bağlaması ve eski vault'un reddi |
| `verifier.rs` | Günlük sayacın ayarlanan saatte UTC gün başına bağlanması |
| `escrow.rs` | Yükseltme yetkilisinin config'i kurması; USDC'yle iş açma, kabul, teslim; challenge penceresi bitmeden (son saniye dahil) finalize reddi, saat pencerenin sonuna gelince ödeme |
