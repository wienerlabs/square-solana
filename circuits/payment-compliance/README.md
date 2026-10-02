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
```

`npm test`, derleme yoksa devre testlerini, PPoT dosyası yoksa tamper testlerini atlar ve sebebini yazar.

## Dosyalar

| Yol | İçerik |
|---|---|
| `payment.circom` | `ReleaseCompliance(10, 10, 8)` |
| `lib/timestamp.circom` | Sağlam UTC gün / saat / hafta günü ayrıştırması (Arc'tan) |
| `scripts/release-input.mjs` | Devre girdisini kurar; yedi kuralı ve commitment'ı devreden bağımsız olarak yeniden hesaplar |
| `scripts/generate_test_inputs.mjs` | `test-inputs/`: 14 senaryo, her biri için girdi ve beklenen public sinyaller |
| `scripts/fetch-ptau.mjs` | Sabitlenmiş PPoT dosyasını indirir ve hash'ini doğrular |
| `scripts/build.mjs` | `payment.circom` ve iki zaman damgası test devresini derler, kısıt sayısını yazar |
| `test/` | `node:test` testleri ve `test/circuits/` altındaki zaman damgası test devreleri |
| `examples/hello.circom` | İş anlamı olmayan araç zinciri sağlaması (BC-06) |

## Anahtarlar

Repoda proving ya da verifying key yoktur (`.gitignore`: `*.zkey`, `*_vk.json`, `*.ptau`). Testler, sabitlenmiş PPoT dosyası üzerinde rastgele entropiyle tek katkılı bir phase-2 ile `build/payment_test.zkey` üretir. Bu bir test anahtarıdır, zincirde hiçbir şey ona bağlanmaz.

- Geliştirme anahtarı ve artefakt hattı (`vk.json` → `groth16_vk.rs`): BC-20.
- Kamusal phase-2 ceremony: BC-38. O zamana kadar hiçbir anahtar için güvence iddiası yoktur.

## Köken

Aperture'ın `circuits/payment-prover` dizininden geçmişiyle taşındı (BC-06, [`docs/provenance/BC-06.md`](../../docs/provenance/BC-06.md)); `LICENSE` Aperture'ındır. BC-19, devreyi release ispatına uyarladı ve Arc'ın (`wienerlabs/square` @ `dc0157f`) aynı devrede yaptığı sağlamlık düzeltmelerini taşıdı. Aperture'ın orijinal README'si: [`wienerlabs/aperture@f5eaba9`](https://github.com/wienerlabs/aperture/blob/f5eaba9df7164da72a8c6d7fed134704356c6aa5/circuits/payment-prover/README.md).
