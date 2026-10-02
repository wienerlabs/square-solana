# Release ispatı devresi

**Durum:** BC-19 (#27) · **Devre:** [`circuits/payment-compliance/payment.circom`](../../circuits/payment-compliance/payment.circom) · **Bağlı sözleşme:** BC-44 v0.1.1 ([program-interface.md](program-interface.md), [`idl/`](../../idl/))

Bu belge, kurumun escrow release'i için ürettiği Groth16 ispatının neyi kanıtladığını ve verifier'ın (BC-21) her public sinyali neye bağlaması gerektiğini tanımlar. Sinyal sırası, ret bitleri ve commitment yapısı trusted setup ile donar (BC-20, BC-38). Bunlardan birini değiştirmek yeni bir proving key ve `square_verifier`'da yeni bir verifying key gerektirir.

## 1. Ne kanıtlanıyor

Kurum, ispatı release'den önce job'a bağlar (akışın 7. adımı). İspat şunu söyler: "Commitment'ı `policy_commitment` olan politika, bu job'un bu payee'ye bu mint'te ödeyeceği bu net tutarı, bu günlük sayaçla bu anda değerlendirdi; şu kurallar çiğnendi (ya da hiçbiri)."

İki sonuç da geçerli bir ispattır:

- `refusal_code = 0`: release politikaya uyuyor → `ReleaseVerdict::Compliant`.
- `refusal_code ≠ 0`: kurumun politikası bu release'e karşı karar verdi → `ReleaseVerdict::Refused`, `ReleaseProof.refusal_code = refusal_code`.

Devre Aperture'ın `payment-prover` devresinden geliyor (BC-06). Arc'ın (`wienerlabs/square` @ `dc0157f`) aynı devrede yaptığı dört sağlamlık düzeltmesi aynen alındı (§9). BC-19'un eklediği kısım: transfer alıcısı yerine payee, net tutar, job bağlama, ayrı bir kural olarak public günlük tavan ve `is_compliant` yerine ret kodu.

## 2. Public sinyaller (13)

Solana adresi 32 bayttır ve tek bir BN254 alan elemanına sığmaz. Adresler iki 128 bitlik yarıyla taşınır: `high` = 0..15. baytlar, `low` = 16..31. baytlar, ikisi de big-endian. Devre her yarıyı 128 bite sınırlar, böylece bir çift her zaman tek bir adresin kanonik bölünmesidir.

| # | Sinyal | Anlamı | Verifier'ın kaynağı (BC-21) |
|---|---|---|---|
| 0 | `refusal_code` | 0 = uyumlu; değilse çiğnenen her kural için bir bit (§3) | ispattan; `ReleaseProof.verdict` ve `refusal_code` buradan yazılır |
| 1 | `policy_commitment` | politikanın salt'lı Poseidon commitment'ı (§5) | `Job` policy snapshot'ı (`policy_commitment`) |
| 2 | `daily_ceiling` | politikanın public günlük tavanı (BC-17) | `Job` policy snapshot'ı (`policy_daily_ceiling`) |
| 3, 4 | `payee_high`, `payee_low` | release'in ödeyeceği adres | `ClaimListing` `Bought` ise alıcı, değilse `Job.agent_wallet` |
| 5 | `net_amount` | payee'nin alacağı tutar (settlement mint birimi) | ispattan; `ReleaseProof.net_amount`. Escrow release'te kendi hesabıyla karşılaştırır |
| 6, 7 | `mint_high`, `mint_low` | settlement mint | `Job` (tek mint: `EscrowConfig.settlement_mint`) |
| 8 | `daily_spent_before` | kurumun o UTC günündeki harcaması | `OperatorState.daily_spent` (gün dönümü uygulanmış, §7) |
| 9 | `current_unix_timestamp` | ispatın değerlendirildiği an (saniye) | ispattan; `Clock::unix_timestamp` ± tolerans içinde olmalı |
| 10, 11 | `job_high`, `job_low` | ispatın ait olduğu escrow `Job` hesabı | `job` hesabının adresi |
| 12 | `stripe_receipt_hash` | MPP makbuz commitment'ı | release yolunda sabit 0; MPP yolunda (BC-37) argüman |

Verifier bu sinyallerin hiçbirini ispatı yapanın beyanına bırakmamalıdır. `net_amount`, `current_unix_timestamp` ve `refusal_code` dışındakilerin hepsi zincirde zaten bilinen değerlerdir. Bağlanmamış bir sinyal ispatı yapanın seçtiği bir sinyaldir. `test/tamper.test.mjs`, 13 sinyalden herhangi biri değişince gerçek bir ispatın doğrulamasının düştüğünü gösterir.

## 3. Ret kodu

`refusal_code`, `u16`'ya sığan bir bit maskesidir. Devre her `rule_ok`'u boolean olarak kısıtlar, bu yüzden maske tektir ve yalnızca yedi kuralın hepsi geçtiğinde 0'dır. Birden çok kural çiğnenirse hepsinin biti birlikte gelir.

| Bit | Değer | Kural | Çiğnenme koşulu |
|---|---|---|---|
| 0 | 1 | işlem başı tavan | `net_amount > max_per_tx` |
| 1 | 2 | gizli günlük tavan | `daily_spent_before + net_amount > max_daily` |
| 2 | 4 | mint whitelist'te değil | `Poseidon(mint)` listede yok |
| 3 | 8 | payee engelli | `Poseidon(payee)` engelli listesinde |
| 4 | 16 | kategori izinli değil | `payment_category` izinli listede yok |
| 5 | 32 | zaman penceresi dışında | pencere açıkken gün ya da saat dışarıda |
| 6 | 64 | public günlük tavan | `daily_spent_before + net_amount > daily_ceiling` |

### BC-24 için: hangi ret kalıcı?

İspatı yapan, release'den para geri alacak taraftır (kurum). Ret "kuruma iade" anlamına geldiğinde, kurumun kendi lehine ret **üretebildiği** kurallar ayrıca ele alınmalıdır ([program-interface.md](program-interface.md) §8 açık nokta 1):

| Bit | Ret, kurumun elinde mi? | Öneri |
|---|---|---|
| 0, 2, 3 | Hayır. Tutar, mint ve payee job'dan ve claim'den gelir; tavan ve listeler job oluşturulurken alınan snapshot'taki commitment'ta sabittir | kalıcı → iade |
| 1, 6 | Zamanlamayla evet. Sayaç kurumun aynı günkü diğer release'leriyle dolar ve UTC gece yarısı sıfırlanır | geçici → bekleme |
| 5 | Zamanlamayla evet. İspatın değerlendirildiği anı kurum seçer | geçici → bekleme |
| 4 | **Tamamen.** `payment_category` ne public sinyaldir ne de zincirde bir şeye bağlıdır (§9). Kurum istediği kategoriyi beyan ederek her release'i reddettirebilir | tek başına iadeye yol açmamalı; ya bekleme ya da kategorinin job'a bağlanması (sözleşme değişikliği) |

Bit 4 ile birlikte gelen kalıcı bir bit (0, 2, 3) yine kalıcı sayılabilir. Karar BC-24'ün ADR'ındadır; devre bütün bitleri ayrı ayrı verdiği için her seçenek uygulanabilir.

## 4. Kurallar

| # | Kural | Private girdiler | Public sinyaller |
|---|---|---|---|
| 1 | `net_amount ≤ max_per_tx` | `max_per_tx` | `net_amount` |
| 2 | `daily_spent_before + net_amount ≤ max_daily` | `max_daily` | `daily_spent_before`, `net_amount` |
| 3 | mint whitelist'te | `token_whitelist[10]` | `mint_high/low` |
| 4 | payee engelli listesinde değil | `blocked_addresses[10]` | `payee_high/low` |
| 5 | kategori izinli | `allowed_categories[8]`, `payment_category` | — |
| 6 | an, pencerenin içinde (pencere açıksa) | `time_active`, `time_days_bitmask`, `time_start_hour_utc`, `time_end_hour_utc` | `current_unix_timestamp` |
| 7 | `daily_spent_before + net_amount ≤ daily_ceiling` | — | `daily_ceiling`, `daily_spent_before`, `net_amount` |

- **Gün ve saat UTC takvimidir:** `day_index = ts / 86400`, haftanın günü Pazartesi = 0 (`time_days_bitmask`'in 0. biti Pazartesi). Kural 2 ve 7'deki "gün" de aynı gündür; `OperatorState` sayacı aynı saate göre dönmelidir.
- **Pencere gece yarısını geçemez:** `start ≤ end` varsayılır, iki uç da dahildir (09–17 → 09:00:00–17:59:59). `start > end` olan bir pencerede hiçbir saat içeride değildir; politika araçları böyle bir pencereyi reddetmelidir.
- **Pencere kapalıyken** (`time_active = 0`) kural 6 geçer, ama üç pencere alanı yine aralık kontrolünden geçer: 0 gönderin.
- **Kural 7'nin sebebi:** Zincir public tavanı kendisi de kontrol edebilir. Kural 7 devrede olduğu için ispatın kararı bu kontrolle hiç çelişmez. Public tavanın durduracağı bir release, "doğrulanan ispat, gerçekleşemeyen release" yerine kendi sebebiyle bir ret olur. Tavan 0 ise hiçbir harcamaya izin verilmez (fail closed).

## 5. Politika commitment'ı

Arc'taki yapıyla aynıdır (square#45): her alan kendi salt'ının arkasındadır, bu yüzden tek bir alan diğerleri açılmadan açılabilir.

```
value[0] = max_daily
value[1] = max_per_tx
value[2] = operator_id_field
value[3] = policy_id_field
value[4] = Poseidon(allowed_categories)   8 yuvaya 0 ile doldurulmuş
value[5] = Poseidon(blocked_addresses)    10 yuvaya 0 ile doldurulmuş
value[6] = Poseidon(token_whitelist)      10 yuvaya 0 ile doldurulmuş
value[7] = pencere yoksa 0, varsa Poseidon(1, days_bitmask, start_hour, end_hour)

leaf[i]    = Poseidon(i, salt[i], value[i])
commitment = Poseidon(leaf[0], …, leaf[7])
```

Liste ve alan kodlamaları (politika araçları bunları bayt bayt aynı üretmelidir):

| Alan | Kodlama |
|---|---|
| `token_whitelist[i]` | `Poseidon(high, low)`, mint adresinin |
| `blocked_addresses[i]` | `Poseidon(high, low)`, cüzdan adresinin |
| `allowed_categories[i]`, `payment_category` | kategori dizesinin UTF-8 baytları 32'ye sıfırla doldurulur, `Poseidon(high, low)`; 1–32 bayt |
| `operator_id_field` | `Poseidon(high, low)`, square_policy `Institution` PDA'sının |
| `policy_id_field` | `Poseidon(high, low)`, `Policy.policy_id` ([u8; 32]) değerinin |
| boş liste yuvaları | `0` |
| `salt[i]` | BN254 alan elemanı. Kurumun gizli tuttuğu tek bir sırdan türetilir; 2^128'den küçük bir sır hiçbir şey gizlemez |

Liste girdileri adreslerin Poseidon görüntüleri olduğundan, Arc'ın EVM devresinin (adres = tek alan) ürettiği commitment bu devreninkiyle eşleşmez. Yapı aynıdır, girdiler farklıdır.

`scripts/release-input.mjs` bu kodlamaların ve commitment'ın devreden bağımsız bir uygulamasıdır. Testler devrenin çıktısını ona göre karşılaştırır.

## 6. Verifier'a düşenler (BC-21)

Her sinyal §2'deki kaynağa bağlanır. Bunun iki uygulama yolu var; devre ikisinde de aynıdır.

**A. Sinyalleri hesaplardan türetmek (önerilen).** Verifier 9 sinyali (1–4, 6–8, 10–11) okuduğu hesaplardan, 12'yi sabit 0 olarak kendisi kurar. İşlem yalnızca `refusal_code: u16`, `net_amount: u64`, `proof_timestamp: i64` ve ispatı (256 B) taşır. Talimat verisi 592 B'den yaklaşık 282 B'ye iner; 13 sinyalin 416 B'lık tamamını göndermek ise işlemi 1 232 B sınırının üstüne çıkarır (sözleşme §8 açık nokta 9). Uyuşmazlık burada yapısal olarak imkânsızdır: başka bir release için yapılmış ispat `InvalidProof` ile düşer. `PayeeMismatch`, `MintMismatch` ve `SnapshotMismatch` gibi açıklayıcı hatalar zincirde oluşmaz. SDK ispatı göndermeden önce aynı türetilmiş sinyallere karşı yerelde doğrulamalı ve hangi bağın farklı olduğunu adıyla söylemelidir.

**B. Hepsini argüman olarak göndermek.** 13 sinyal gönderilir ve her biri hesaplarla karşılaştırılır; açıklayıcı hatalar korunur. Sınıra sığmak için ispat noktalarının sıkıştırılması (G1 32 B, G2 64 B; `alt_bn128` sıkıştırma syscall'ları) gerekir.

Her iki yolda da:

- **Sayaç ve gün:** `daily_spent_before`, `OperatorState`'in ispat anının UTC gününe göre değeridir. `OperatorState.day_start_unix` daha eski bir güne aitse etkin sayaç 0'dır.
- **Saat:** `current_unix_timestamp`, `Clock::unix_timestamp`'a göre küçük bir tolerans içinde olmalı (Arc'ta sahibi tarafından ayarlanabilir). Tolerans, kurumun pencere sınırında saat seçebildiği aralıktır.
- **Malleability:** Groth16 ispatı kodlamasına bağlı değildir. Aynı sinyaller için yeniden rastgeleleştirilmiş bir kopya da doğrulanır (Arc `compliance-gate.md`). Burada zararsızdır: `ReleaseProof` job başına bir PDA'dır, sinyaller job'u içerir ve ispatı yalnızca kurumun yetkilisi bağlayabilir. Tüketilmiş bir ispatı işaretlemek gerekirse işaret ispatın baytlarına değil sinyallere konmalıdır.
- **CU:** 10 yerine 13 public input, ispat hazırlamada üç ek G1 çarpımı demektir. Ölçüm BC-21'in kabul kriteri.

### Sözleşmeye etkisi (bir sonraki sözleşme sürümü için)

| Yüzey (`idl/square_verifier_contract.json`) | v0.1.1 | Bu devreyle |
|---|---|---|
| `public_inputs` uzunluğu | 10 | 13 |
| `set_compliance_proof` argümanları | `proof_a/b/c`, `public_inputs: [[u8; 32]; 10]` | A: `proof_a/b/c`, `refusal_code: u16`, `net_amount: u64`, `proof_timestamp: i64` · B: 13 sinyal + sıkıştırılmış noktalar |
| `ReleaseProof.refusal_code` | "devreyle BC-19'da tanımlanır" | §3'teki bit maskesi |
| `verify_mpp_payment_proof` | 10 sinyal | aynı 13 sinyal; `stripe_receipt_hash` ≠ 0 |

Sözleşme (`idl/*.json`) Muhammed'de (BC-44, BC-21); bu tablo öneridir, bu PR IDL'e dokunmuyor.

## 7. Gizlilik

Zincire çıkmayanlar: iki gizli tavan, üç liste, ödeme kategorisi, zaman penceresi, sekiz salt, operatör ve politika kimliği. Zincirin gördüğü: §2'deki 13 sinyal.

- **Ret kodu bilgi verir:** Bir ret, hangi kuralın çiğnendiğini gösterir. Örneğin bit 3, bu payee'nin kurumun engelli listesinde olduğunu açığa çıkarır. Bu, sözleşmenin ret sebebini zincire yazma kararının sonucudur ve yalnızca reddedilen release'in kendi değerleri için geçerlidir.
- **Salt'lar tek sırdan türetiliyorsa** commitment'ın gizliliği o sırrın entropisi kadardır. `max_daily` ve `max_per_tx` gibi yuvarlak tutarlar kısa bir sözlükle denenebilir (Arc'ta 25 USDC'lik tavan, `"0"` salt'ıyla 50 denemede bulundu).

## 8. Kısıt maliyeti

circom 2.2.3, varsayılan optimizasyon:

| | Aperture (BC-06) | Arc (`dc0157f`) | **Bu devre** |
|---|---|---|---|
| Kısıtlar | 7 377 (2 863 + 4 514) | 11 556 | **13 495 (6 228 doğrusal olmayan + 7 267 doğrusal)** |
| Public sinyaller | 10 | 8 | **13** |
| Private girdiler | 73 | — | **56** |
| Powers of tau | 2^13 | 2^14 | **2^14** (16 384; 2 876 kısıtlık pay) |

Artışın kaynakları: salt'lı commitment (8 × `Poseidon(3)`), altı adres yarısının 128 bit kontrolü, payee ve mint için iki `Poseidon(2)`, kural 7 ve sağlam zaman ayrıştırması. `test/constraints.test.mjs` derlemenin bu sayılarla aynı kaldığını kontrol eder.

Apple M1 Pro, Node 25, test anahtarıyla ölçüldü: ispat 0,63–0,86 s, doğrulama 11 ms, en yüksek bellek ~970 MB. `payment.wasm` 5,7 MB, `zkey` 6,0 MB, `vk.json` 5 KB.

## 9. Aperture devresinden farklar

| # | Aperture'da | Bu devrede | Kaynak |
|---|---|---|---|
| 1 | Zaman ayrıştırmasında bölümler üstten sınırsızdı; ispatı yapan haftanın gününü seçebiliyordu | `lib/timestamp.circom`: her bölüm ve kalan sınırlı; kontrol devresiyle test ediliyor | Arc square#14 |
| 2 | Liste maskeleri commitment'a girmiyordu; engelli listesinin maskesi sıfırlanınca kural 4 kapanıyordu | Maskeler yok; boş yuvalar 0, aranan üç anahtar sıfırdan farklı olmaya zorlanıyor | Arc square#14 |
| 3 | Karşılaştırıcıların operandları aralık kontrolsüzdü | Bütün tutarlar 64 bit, saat sınırları 5 bit, `time_active` boolean | Arc square#14, #119 |
| 4 | Commitment salt'sız `Poseidon(8)` idi; değerler tahmin edilebiliyordu | Alan başına salt'lı yaprak + kök | Arc square#45 |
| 5 | Transfer alıcısı, brüt tutar, `is_compliant` | Payee, net tutar, job bağlama, public tavan kuralı, ret kodu | BC-19 |

**Kural 5 kimseyi bağlamaz.** `payment_category` ne public sinyaldir ne de commitment'ın bir girdisidir. Dürüst bir prover izinsiz kategoride reddeder, ama tanığı elle yazan biri kuralı istediği yöne çevirebilir. Arc da aynı sonuca vardı (`circuits/README.md`, "Rule 5 binds nobody"). Square'de bunun sonucu §3'teki tabloda.

## 10. Test

`circuits/payment-compliance/` altında:

```bash
npm ci
CIRCOM=/path/to/circom npm run build   # circom 2.2.3
npm run fetch-ptau                     # PPoT katkı 80, 2^14, ~19 MB, sha256 ile doğrulanır
npm test
```

| Dosya | Ne kanıtlar |
|---|---|
| `test/fixtures.test.mjs` | `test-inputs/`'taki 14 senaryo (her kural için ok/bad, sınırlar, satılmış claim, çoklu ihlal) kayıtlı sinyalleri üretiyor; dosyalar üreticiyle güncel |
| `test/rules.test.mjs` | 60 üretilmiş release'de 13 sinyalin hepsi bağımsız değerlendirmeyle aynı; gün/saat UTC takvimi; commitment her alanla ve her salt'la değişiyor, release'le değişmiyor |
| `test/soundness.test.mjs` | Aralık dışı tutar, adres yarısı, saat, pencere alanı ve sıfır anahtar reddediliyor; maske girdisi yok; sahte hafta günü eski ayrıştırmada geçiyor (kontrol), yenisinde reddediliyor |
| `test/tamper.test.mjs` | Gerçek Groth16 ispatı: 13 sinyalden herhangi biri değişince doğrulama düşüyor; ret ispatı uyumlu gösterilemiyor; başka job ya da payee için doğrulanmıyor |
| `test/constraints.test.mjs` | Kısıt sayısı ve sinyal sırası bu belgeyle aynı |

Tamper testlerinin anahtarı, sabitlenmiş PPoT dosyası üzerinde rastgele entropiyle tek katkılı bir phase-2'dir. Yerelde üretilir, repoya girmez ve zincirde hiçbir şey ona bağlanmaz. Geliştirme anahtarı ve artefakt hattı BC-20'de, kamusal ceremony BC-38'de.

## 11. Kaynaklar

- Aperture `circuits/payment-prover/payment.circom` (BC-06 ile taşındı, [`docs/provenance/BC-06.md`](../provenance/BC-06.md))
- `wienerlabs/square` @ `dc0157f`: `circuits/payment.circom`, `circuits/lib/timestamp.circom`, `circuits/README.md`, `docs/design/compliance-gate.md`, `docs/decisions/public-daily-ceiling.md`
- Perpetual Powers of Tau: [privacy-ethereum/perpetualpowersoftau](https://github.com/privacy-ethereum/perpetualpowersoftau), katkı 80
