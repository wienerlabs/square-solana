# payment-compliance: release ispatı devresi

Kurumun bir escrow release'inin kendi politikasına uyup uymadığını, uymuyorsa hangi kuralları çiğnediğini kanıtlayan Circom / Groth16 devresi. İspat tek bir release'e bağlıdır: job, payee, net tutar, mint, günlük sayaç ve an. `square_verifier` (BC-21) ispatı job'un `ReleaseProof` hesabı olarak yazar, `square_escrow` (BC-24) de buna göre öder, iade eder ya da bekler.

**Normatif tanım:** [`docs/design/release-circuit.md`](../../docs/design/release-circuit.md). Public sinyallerin sırası, ret kodu bitleri, commitment yapısı, verifier'ın her sinyali neye bağlayacağı ve kısıt maliyeti orada.

| | |
|---|---|
| Public sinyaller | 13: `refusal_code`, `policy_commitment`, `daily_ceiling`, `payee_high/low`, `net_amount`, `mint_high/low`, `daily_spent_before`, `current_unix_timestamp`, `job_high/low`, `stripe_receipt_hash` |
| Kurallar | işlem başı tavan, gizli günlük tavan, mint whitelist, engelli payee, kategori, zaman penceresi, public günlük tavan |
| Kısıtlar | 13 495 (circom 2.2.3), powers of tau 2^14 |

## Kullanım

Bu dizin pnpm workspace'inin parçası değildir; bağımlılıklar burada `npm ci` ile kurulur.

```bash
npm ci
CIRCOM=/path/to/circom npm run build   # circom 2.2.3; build/ altına r1cs, wasm, sym
npm run fetch-ptau                     # PPoT katkı 80, 2^14 (~19 MB), sha256 ve blake2b ile doğrulanır
npm test                               # 52 test; tamper testleri gerçek Groth16 ispatı üretir
npm run inputs                         # test-inputs/'u yeniden üretir (--check: güncel mi)
npm run artifacts:check                # release artefaktlarını yeniden üretip karşılaştırır (Node 24)
npm run program-proofs                 # program testlerinin gerçek ispatları (--squads: yalnızca BC-35'inki; --check: geçerli mi)
scripts/clean-room.sh check            # aynısı, commit'lenmiş HEAD'in Docker'daki temiz klonunda
```

`npm test`, derleme yoksa devre testlerini, PPoT dosyası yoksa tamper testlerini atlar ve sebebini yazar. CI'da (`CIRCUIT_TESTS_STRICT=1`, [`circuits.yml`](../../.github/workflows/circuits.yml)) atlamaz, düşer; CI ayrıca `inputs:check`, `artifacts:check` ve `program-proofs:check`'i koşturur.

## Dosyalar

| Yol | İçerik |
|---|---|
| `payment.circom` | `ReleaseCompliance(10, 10, 8)` |
| `lib/timestamp.circom` | Sağlam UTC gün / saat / hafta günü ayrıştırması (Arc'tan) |
| `scripts/release-input.mjs` | Devre girdisini kurar; yedi kuralı ve commitment'ı devreden bağımsız olarak yeniden hesaplar |
| `scripts/generate_test_inputs.mjs` | `test-inputs/`: 14 senaryo, her biri için girdi ve beklenen public sinyaller |
| `scripts/fetch-ptau.mjs` | Sabitlenmiş PPoT dosyasını indirir ve hash'ini doğrular |
| `scripts/build.mjs` | `payment.circom` ve iki zaman damgası test devresini derler, kısıt sayısını yazar |
| `scripts/release-artifacts.mjs` | Release artefakt hattı: `setup`, `check`, `write` (aşağıda) |
| `scripts/program-proofs.mjs` | `tests/programs/tests/fixtures/release-proofs.json`: verifier'ın program testleri (BC-21) için yedi senaryonun gerçek ispatı (uyumlu, ret, alıcıya, başka mint, başka politika, ikinci job, güncel sayaç). Senaryolar `release-input.mjs`'in test dünyasında kurulur; testler aynı etiketlerden aynı anahtarları türetir. Ayrıca `tests/programs/tests/fixtures/squads-proofs.json`: Squads vault'larıyla sekiz adım (BC-35); kurum, agent ve alıcı vault'u etiketlerden türetilen multisig adreslerinden, ispat alıcı vault'una ödeyen uyumlu release (`--squads` yalnızca bunu yazar). `--check` iki fikstürdeki her ispatı doğrulama anahtarına ve yeniden hesaplanan sinyallere karşı doğrular |
| `scripts/clean-room.sh` | Hattı Docker'da temiz klonla çalıştırır (Node `.nvmrc`, circom 2.2.3 resmi ikilisi, sha256 doğrulanır) |
| `scripts/groth16-solana.mjs`, `scripts/extract-vk-rust.mjs` | snarkjs → groth16-solana bayt düzeni; doğrulama anahtarı → Rust sabiti |
| `artifacts/` | Release zkey'i, doğrulama anahtarı ve manifest (BC-20) |
| `test/` | `node:test` testleri ve `test/circuits/` altındaki zaman damgası test devreleri |

## Anahtarlar

### Release anahtarı (BC-20)

| Parça | Değer |
|---|---|
| Phase 1 | Perpetual Powers of Tau, katkı 80, 2^14: `ppot_0080_14.ptau`, 18 967 698 bayt |
| Phase 1 sha256 | `3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db` |
| Phase 1 blake2b | `a91842802f01b33fd42f5f69c3e49879ae03f0ae1f448b0c151244c9957024bd30bf5e3cc999ff2aeb02ebb959124a3a6a3cc20691cb4843a1234a02232072f3` |
| Phase 1 kaynağı | `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_14.ptau`; güven kaynağı adres değil hash'tir, yansılar: [privacy-ethereum/perpetualpowersoftau](https://github.com/privacy-ethereum/perpetualpowersoftau) |
| Phase 2 | **Geliştirme:** tek katkı (`artifacts/manifest.json` → `phase2`) |
| zkey | `artifacts/payment.zkey`; sha256 ve devre hash'i manifest'te |
| Doğrulama anahtarı | `artifacts/verification_key.json` → `programs/square-verifier/src/release_vk.rs` (`SQUARE_RELEASE_VK`, 13 public girdi) |

Hat (`scripts/release-artifacts.mjs`):

- `setup`: tek seferlik. Yeni zkey üretir; entropi işletim sisteminden alınır ve hiçbir yere yazılmaz. Ardından `write` çalışır. Devre değişince yeniden çalıştırılır ve doğrulama anahtarı değişir.
- `check`: her şeyi yeniden üretir ve commit'lenmiş hâliyle karşılaştırır:
  - ptau hash'i;
  - circom sürümü, r1cs ve wasm hash'leri;
  - zkey'in bu r1cs ve ptau'dan türediği (`snarkjs zkey verify`), devre hash'i ve katkı kaydı;
  - zkey'den çıkarılan doğrulama anahtarı ve Rust sabiti.

  Bir fark hata verir. r1cs ve wasm macOS (circom kaynaktan) ile Linux'ta (resmi ikili) aynı hash'i verir.
- `write [--vector]`: mevcut zkey'den doğrulama anahtarını, Rust dosyasını ve manifest'i yazar. `--vector`, `release_vk_vector.rs`'teki gerçek ispatı yeniler; `cargo test -p square-verifier` bu ispatı programın kullandığı groth16-solana ile doğrular.

Hat `.nvmrc`'deki Node sürümüyle (24) çalışır. snarkjs 0.7.6'nın zkey doğrulaması ptau dosyasını açıp kapatmıyor; Node 24 bunu uyarıyla geçer, Node 26 ise hata fırlatır.

### Disclosure

**Phase-2 yalnızca geliştirme içindir.** Tek bir katkıdan oluşur, kamusal bir tören değildir ve **hiçbir güvence iddiası yoktur.** Katkıyı yapan taraf toksik atığı saklamış olsaydı sahte ispat üretebilirdi. Entropi saklanmadı, ama bu bir iddiadan öteye geçmez. Bu anahtar devnet ve test içindir; mainnet'e kamusal phase-2 töreninin (BC-38) anahtarıyla çıkılır. Phase 1 ise gerçek, çok katılımcılı bir törendir (PPoT, 80 katkı).

### Test anahtarı

Testler, aynı PPoT dosyası üzerinde rastgele entropiyle tek katkılı bir phase-2 ile `build/payment_test.zkey` üretir. Bu anahtar commit'lenmez ve zincirde hiçbir şey ona bağlanmaz.

## Köken

Aperture'ın `circuits/payment-prover` dizininden geçmişiyle taşındı (BC-06, [`docs/provenance/BC-06.md`](../../docs/provenance/BC-06.md)); `LICENSE` Aperture'ındır. BC-19, devreyi release ispatına uyarladı ve Arc'ın (`wienerlabs/square` @ `dc0157f`) aynı devrede yaptığı sağlamlık düzeltmelerini taşıdı. Aperture'ın orijinal README'si: [`wienerlabs/aperture@f5eaba9`](https://github.com/wienerlabs/aperture/blob/f5eaba9df7164da72a8c6d7fed134704356c6aa5/circuits/payment-prover/README.md).
