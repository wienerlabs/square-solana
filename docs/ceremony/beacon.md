# Beacon

**Kaynak: drand mainnet `quicknet` zinciri, tören açılmadan önce duyurulan bir tur.**

Phase-2 zinciri, katılımcılardan en az biri entropisini yok ettiyse sağlamdır. Beacon bunu bile kimseye inanmayı gerektirmeden sağlar: son katkıyı, katkılar yapılırken kimsenin bilemeyeceği ve sonradan herkesin denetleyebileceği bir değerle kapatır. Beacon olmasaydı, bütün katılımcıların anlaştığı bir zincirle dürüst bir zincir ayırt edilemezdi.

Değer bu işi ancak tören sürerken **öngörülemez** ve sonra **doğrulanabilir** olursa görür. İkisini birden sağlayan, hangi değer olacağının önceden duyurulmasıdır. Sonradan seçilen bir beacon hiçbir şey kanıtlamaz.

## Parametreler

| | |
|---|---|
| Ağ | drand mainnet, `quicknet` |
| Zincir hash'i | `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` |
| Şema | `bls-unchained-g1-rfc9380`: imza G1'de, grup anahtarı G2'de; imzalanan mesaj tur numarasının (u64, big-endian) SHA-256'sı |
| Grup anahtarı | `83cf0f28…5ece45a` (tamamı `ceremony.mjs`'te `DRAND.publicKey`) |
| Genesis | `1692803367` |
| Period | 3 saniye |
| Tur | **takvimle birlikte, davetlerden önce duyurulur**; `init --beacon-round` onu transcript'e yazar |

Tur, düştüğü anın saf bir fonksiyonudur:

```
tur(T) = floor((T - 1692803367) / 3) + 1        an(tur) = 1692803367 + (tur - 1) * 3
```

Bu yüzden duyuru bir tarih ve bir turu birlikte verebilir, ikisi birbirinden kayamaz.

## Neden drand

- **Blok hash'i:** Bitcoin ya da Ethereum blok hash'i öğütülebilir: sonucu beğenmeyen bir madenci ya da önerici bir bloğu bırakıp sonrakini alabilir. Blok yüksekliği de önceden kesin bir ana karşılık gelmez.
- **drand:** Bir eşik ağıdır. Tek bir katılımcı bir turu öngöremez ya da saklayamaz. Değer, zincirin grup anahtarına karşı herkesin doğrulayabileceği bir BLS imzasıdır ve turlar 3 saniyelik sabit bir takvimle düşer. Ethereum Foundation'ın KZG töreni de drand'ı kullandı.
- **Tek kaynaklı beacon'lar (ör. NIST):** Doğrulanabilir ama tek bir otoritenin elindedir. Beacon'ın amacı rastgelelik eklemek değil, bir tarafa güvenme ihtiyacını kaldırmaktır.

## Nasıl uygulanır

1. **Duyuru:** Tur, takvimle birlikte ve herhangi bir katkıdan önce duyurulur. `init` turun gelecekte olduğunu denetler ve onu duyurunun adresiyle birlikte transcript'e yazar.
2. **Katkılar:** Toplanır. `contribute`, tur düştükten sonra katkı kabul etmez.
3. **Uygulama:** Son katkıdan sonra, tur düşünce `beacon` şunları yapar:
   - drand'ın zincir bilgisini alır. Zincirin hash'ini sunulan parametrelerden **yeniden hesaplar**; sunulan `chain_hash` alanına güvenmez. Grup anahtarının sabit anahtarla aynı olduğuna bakar.
   - Turun imzasını **araçta sabit** grup anahtarına karşı doğrular. `/info`'nun verdiği anahtarla doğrulamak, yalnızca sunucunun kendisiyle tutarlı olduğunu gösterirdi.
   - Turun son katkıdan sonra düştüğüne bakar.
   - İmzayı (96 onaltılık karakter, 48 bayt) beacon değeri olarak uygular: `snarkjs zkey beacon <son> <final> <imza> 10`.
4. **Kayıt:** Turun kaydı (`drand-quicknet-round-<R>.json`) transcript'le birlikte yayımlanır; üçüncü taraf imzayı yeniden doğrular ([verifying.md](verifying.md)).

**Değer imzanın kendisidir, özeti değil.** `snarkjs zkey beacon` 255 bayta kadar her onaltılık diziyi anahtara olduğu gibi yazar; yineleme üssü bu değerin üstünde çalışır. Önce hash'lemek öngörülemezliğe bir şey katmaz, yalnızca her üçüncü tarafın aynen tekrarlaması gereken bir adım ekler. `10`, snarkjs'in izin verdiği en küçük yineleme üssüdür ve son anahtara yazılır.

## Kapanışta doğru olması gerekenler

- **Tur:** Son anahtardaki beacon'ın turu duyurulan turdur.
- **Değer:** Anahtardaki değer, drand'ın o tur için yayımladığı imzadır ve imza quicknet grup anahtarına karşı geçerlidir.
- **Zaman:** Tur, son katkının transcript'teki zamanından **sonra** düşmüştür. Katkılar açıkken var olan bir beacon kimseyi bağlamaz: son katılımcı, bildiği bir değere göre entropisini öğütebilirdi.

`verify-chain` üçünü de denetler.
