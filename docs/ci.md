# CI kontrolleri

**Issue:** BE-03 (#17), BC-12 (#12), BC-13 (#13)

Her PR'da koşan kontroller, neyi denetledikleri, yerelde nasıl çalıştırıldıkları ve merge kuralı.
İş akışları [`.github/workflows/`](../.github/workflows/) altındadır; indirilen her araç (Agave, Anchor,
circom, gitleaks, solana-verify) SHA-256 ile, action'lar commit SHA'sıyla sabitlenir.

## Kontroller

PR sayfasında görünen ad, iş akışındaki işin adıdır.

| İş akışı | Kontrol (PR'daki ad) | Ne zaman | Ne denetler |
|---|---|---|---|
| `packages` | Kapsam, ad kuralı ve lint · Derleme, tip kontrolü ve testler · Paket kurulum smoke'u · Prisma migration kontrolü · `ci-ok` | her PR, main | TS paketleri ve servisler: ad kuralı, ESLint + Prettier, `scripts/ci` testleri, derleme / tip / test (PR'da etkilenen paketler), paket kurulumu, migration kuralları (BE-03) |
| `contract` | `api-sdk-contract` | her PR, main | IDL'den türetilen dosyalar (`packages/types`, SDK IDL kopyaları, `docs/api/schemas`) `idl/` ile güncel: `pnpm contract:check` (BE-35) |
| `License` | Lisans envanteri | her PR, main | Bağımlılık lisansları ve `docs/THIRD_PARTY_LICENSES.md` güncel (BC-02) |
| `Security` | Sır taraması (gitleaks) | her PR, main, haftalık | Bütün git geçmişinde sır; kuralların testleri (BC-13) |
| `Programs` | SBF derleme ve program testleri | programları, crate'leri, IDL'leri, Rust araç dosyalarını ya da bu iş akışının betiklerini değiştiren PR, main | Araç sürümleri, `cargo fmt`, `anchor build`, program IDL'lerinin sözleşmeyle uyumu, `cargo clippy`, birim testleri, `anchor test` (LiteSVM) (BC-12, BC-13) |
| `Circuits` | Devre derlemesi, testleri ve release artefaktları | `circuits/` ya da verifier'ın VK dosyalarını değiştiren PR, main | circom 2.2.3 derlemesi, devre testleri (atlamasız), test girdileri ve release artefaktları güncel (BC-13) |
| `Verifiable build` | Verifiable build (solana-verify) | main'de programları etkileyen push; elle; PR'da yalnızca kendi dosyası değişince | Programların Docker'da deterministik derlemesi ve executable hash'leri (BC-13) |

`reviewer` iş akışı kontrol değildir: PR'a reviewer ister.

### Program kontrolleri ve programların durumu

Programların sözleşmeye göre durumu tek yerdedir: [`scripts/ci/programs.mjs`](../scripts/ci/programs.mjs).

| Durum | Program | IDL | Rust |
|---|---|---|---|
| `contract` | sözleşmeyle yazıldı | derlenen IDL sözleşme IDL'iyle aynı olmalı; fark CI'ı düşürür | `cargo fmt --check`, `cargo clippy -D warnings` |
| `legacy` | henüz kaynak projenin arayüzünde | farklar bildirilir, CI'ı düşürmez | yalnızca derleme; clippy uyarıları bildirilir |

- **IDL uyumu** ([`idl-conformance.mjs`](../scripts/ci/idl-conformance.mjs)): `anchor build`'in yazdığı
  `target/idl/<program>.json`, `idl/<program>_contract.json` ile karşılaştırılır. `address` (yeni program
  kimlikleri BC-09'da) ve `metadata` dışındaki her şey sözleşmedir: talimatlar, hesap sırası ve bayrakları,
  PDA tanımları, argüman tipleri, hesaplar, tipler, event'ler, hata kodları ve mesajları, sabitler,
  doküman satırları. Farkta CI, ilk ayrışan yolu yazar (ör. `instructions.update_policy: sözleşmeden farklı
  (accounts[2].writable)`).
- **Kısmi geçiş:** Sözleşmenin bir bölümü sonraki bir issue'daysa öğeler programın `pending` listesine o
  issue'yla yazılır. Listedeki öğe programda olmamalı, listede olmayan her öğe sözleşmeyle aynı olmalı.
- **Listenin kendisi denetlenir:** Anchor.toml'daki her program, `idl/` altındaki her sözleşme IDL'i ve
  `programs/` altındaki her crate listede olmalı. IDL'i sözleşmeyle aynı olduğu hâlde `legacy` kalan
  program CI'ı düşürür.
- **Bir programı sözleşmeye geçiren PR** (BC-21 verifier, BC-22 escrow …) programın durumunu `contract`
  yapar; o PR'da program biçim ve lint kurallarına da uyar.
- **IDL değişikliği:** Sözleşme `idl/`'de değişir ([program arayüzü §11](design/program-interface.md#11-sözleşme-değişiklik-kaydı));
  türetilen dosyalar `contract` iş akışında, programın uyumu `Programs`'ta denetlenir.
- **Araç sürümleri** ([`toolchain.mjs`](../scripts/ci/toolchain.mjs)): iş akışlarındaki `AGAVE_VERSION`,
  `ANCHOR_VERSION` ve verifiable build imajının etiketi `Anchor.toml [toolchain]` ile aynı olmalı
  ([ADR 0007](decisions/0007-anchor-surumu.md)).

### Devre

`Circuits` işi CI'da `CIRCUIT_TESTS_STRICT=1` ile koşar: derleme ya da PPoT dosyası eksikse devre testleri
yerelde olduğu gibi atlanmaz, düşer. Release artefaktlarının denetimi (`npm run artifacts:check`) r1cs ve
wasm hash'lerini, zkey'in r1cs ve PPoT'tan türediğini, doğrulama anahtarını ve verifier'ın Rust VK'sını
commit'lenmiş hâliyle karşılaştırır ([devre README'si](../circuits/payment-compliance/README.md)).

### Sır taraması

- **Kurallar:** [`.gitleaks.toml`](../.gitleaks.toml), gitleaks'in varsayılan kuralları ve iki Solana
  kuralı: `solana-keygen` biçimindeki keypair dosyası ve `fromSecretKey(...)` ya da secret / private key /
  keypair adlı bir alandaki 64 baytlık dizi. İstisnalar yol bazında değil, değer bazında ve gerekçesiyle
  yazılır.
- **CI:** `Security` iş akışı HEAD'den erişilen bütün geçmişi tarar; PR'da HEAD, PR'ın merge commit'idir.
- **Yerel:** `pnpm install`, git kancalarını [`.githooks/`](../.githooks/)'a bağlar (`core.hooksPath`).
  pre-commit kancası commit'lenecek değişiklikleri tarar; bulgu varsa ya da gitleaks kurulu değilse
  commit durur. gitleaks en az [`scripts/security/gitleaks.env`](../scripts/security/gitleaks.env)'deki
  sürüm olmalı (macOS: `brew install gitleaks`). Bütün geçmiş: `pnpm secrets:scan`.
- **Bulgu:** Gerçek bir sırsa commit'ten çıkarılır ve anahtar yenilenir; geçmişe girdiyse geçmiş temizlenir.
  Yanlış alarmsa `.gitleaks.toml`'a değer bazında istisna yazılır.

### Verifiable build

Programlar `solana-verify` ile, Agave sürümüne göre seçilen ve digest'le sabitlenen
`solanafoundation/solana-verifiable-build` imajında derlenir. İş, her `.so`'nun executable hash'ini
özetine yazar ve `.so`'ları hash'lerle birlikte artefakt olarak saklar. Aynı commit'ten yerelde aynı hash:

```bash
solana-verify build --base-image <verifiable-build.yml'deki BASE_IMAGE> --library-name square_policy
solana-verify get-executable-hash target/deploy/square_policy.so
```

Elle tetiklemede `rpc_url` verilirse her programın zincirdeki hash'i (`solana-verify get-program-hash`,
kimlikler `Anchor.toml`'dan) derlenenle karşılaştırılır; fark işi düşürür. Square'in program kimlikleri
BC-09'da, devnet deploy'u BC-30'da gelir.

## Merge kuralı

GitHub'ın zorunlu kontrolleri (branch protection, rulesets) private depoda ücretli plan ister; bu depoda
açık değil. Kural yazılıdır ve her merge'de uygulanır:

1. PR'da koşan **her** kontrol yeşil olmalı. Yol filtresi yüzünden koşmayan iş akışı (ör. yalnızca TS
   değiştiren PR'da `Programs`) kontrol sayılmaz; koştuysa yeşil olmalı.
2. Kırmızı bir kontrol "ilgisiz" diye geçilmez: düzeltilir ya da kararsız bir testse yeniden koşturulup
   sebebi PR'a yazılır.
3. Merge yalnızca merge commit'iyle yapılır (`gh pr merge <no> --merge`); squash ve rebase taşınan git
   geçmişini bozar.
4. main'e doğrudan push edilmez.

Zorunlu kontroller açılabildiğinde (ücretli plan ya da public depo) her PR'da koşan `ci-ok`,
`api-sdk-contract`, `Lisans envanteri` ve `Sır taraması (gitleaks)` doğrudan zorunlu yapılabilir. Yol
filtreli `Programs` ve `Circuits` için GitHub, koşmayan bir zorunlu kontrolü sonsuza kadar bekler; onlar ya
filtresiz koşturulur ya da `packages`'taki `ci-ok` gibi her PR'da koşan bir özet işe bağlanır.

## Yerelde

```bash
node scripts/ci/toolchain.mjs           # araç sürümleri Anchor.toml ile aynı
node scripts/ci/rust-lint.mjs           # cargo fmt --check + clippy (kapsam: programs.mjs); fmt | clippy
anchor build && node scripts/ci/idl-conformance.mjs   # program IDL'leri ↔ idl/
anchor test --validator legacy --skip-build            # program testleri (LiteSVM)
pnpm contract:check                     # IDL'den türetilen dosyalar
pnpm secrets:scan                       # gitleaks, bütün geçmiş
node --test "scripts/ci/*.test.mjs"     # CI betiklerinin testleri
cd circuits/payment-compliance && CIRCUIT_TESTS_STRICT=1 npm test   # devre testleri, atlamasız
```
