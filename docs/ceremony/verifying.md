# Töreni doğrulamak

Bir katılımcının ya da üçüncü bir tarafın, kimseye sormadan koşturabileceği doğrulama. Gereken her şey repodadır: devre, PPoT'un hash'i, son anahtar (`circuits/payment-compliance/artifacts/payment.zkey`), doğrulama anahtarı, transcript ve beacon turunun kaydı (`artifacts/ceremony/`).

## Tek komut

```bash
cd circuits/payment-compliance
npm ci
npm run fetch-ptau
CIRCOM=/path/to/circom node scripts/ceremony.mjs verify-chain
```

`verify-chain` ilk sorunda durmaz; her denetimin sonucunu yazar ve biri bile düşerse sıfırdan farklı kodla çıkar.

| Denetim | Neye bakar |
|---|---|
| phase-1 file | PPoT dosyası sabit hash'te (`ppot_0080_14.ptau`, sha256 `3ca1149e…83db`) ve transcript aynı dosyayı kaydediyor |
| circuit | Devre circom 2.2.3 ile yeniden derlenir. r1cs'in SHA-256'sı törenin başladığı devreninkiyle, circom sürümü kayıtlıyla aynıdır |
| final key | Son anahtarın SHA-256'sı beacon'ın kapattığı anahtarınkidir |
| contributions | Anahtar devreye ve PPoT'a karşı doğrulanır (`snarkjs zkey verify`; her katkının bilgi kanıtı dahil). Anahtardaki her katkının adı ve hash'i, sırasıyla, transcript'teki kayıtla aynıdır. Son katkı beacon'dır: değeri turun imzası, yineleme üssü 10. Eksik, fazla ya da hash'siz kayıt düşer |
| beacon | Tur duyurulan turdur ve son katkıdan **sonra** düşmüştür. İmza, araçta sabit olan quicknet grup anahtarına karşı geçerlidir; yayımlanan tur kaydı aynıdır. `--offline` verilmezse drand'dan canlı olarak alınır: zincir quicknet midir (hash yeniden hesaplanır) ve drand o tur için aynı imzayı mı yayımlıyor |
| verifying key | Son anahtardan çıkarılan doğrulama anahtarı `artifacts/verification_key.json`'la ve transcript'teki hash'le aynıdır |
| manifest | Manifest törenin kaydını gösterir (`phase2.kind: "ceremony"`), transcript'in ve anahtarın SHA-256'sını tutar |

Doğrulama anahtarından üretilen Rust sabiti (`programs/square-verifier/src/release_vk.rs`) ayrıca `npm run artifacts:check` ile yeniden üretilip karşılaştırılır. Programın zincirdeki kodunun bu kaynaktan derlendiği verifiable build ile doğrulanır ([ci.md](../ci.md)).

## Katılımcının kendi katkısı

Tören sürerken ve bittikten sonra katılımcı şunlara bakar:

- **Hash:** Yayımladığı katkı hash'i transcript'te kendi adıyla, doğru sırada yer almalı.
- **Anahtar:** `verify-chain`'in "contributions" denetimi bu hash'in son anahtarın içinde de olduğunu gösterir. Katkısını içermeyen bir zincir, katılımcıların kendi yayımladığı değerlerle karşılaştırıldığı için burada düşer.

## Elle

Araca güvenmek istemeyen biri aynı şeyi snarkjs'le yapabilir:

```bash
npx snarkjs zkey verify build/payment.r1cs build/ppot_0080_14.ptau artifacts/payment.zkey
```

Çıktı her katkıyı (`contribution #N <ad>:` ve hash'i) ve sondaki beacon'ı (`Beacon generator: <imza>`, `Beacon iterations Exp: 10`) yazar; bunlar transcript'le karşılaştırılır. Beacon için:

```bash
curl -s https://api.drand.sh/v2/beacons/quicknet/rounds/<R>   # imza, "Beacon generator"la aynı olmalı
```

Turun düştüğü an [beacon.md](beacon.md)'deki formülle hesaplanır ve son katkının transcript'teki zamanından sonra olmalıdır. İmzanın quicknet grup anahtarına karşı geçerliliği drand'ın kendi istemcileriyle de doğrulanabilir.
