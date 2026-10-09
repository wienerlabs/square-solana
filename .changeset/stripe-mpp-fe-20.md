---
'@squaresdk/solana-web': minor
---

Kartla ödeme: fiat rayının arayüzü (FE-20; ADR 0024, ADR 0026).

- **İş açma:** "Card in USD (Stripe)" rayı `create_fiat_job` ile açılır. Politika zorunludur; challenge süresi ve
  fonlama yoktur. Tutar tam sent olmalı ve Stripe'ın en düşük tutarının altında olmamalı. İki tarafın screening'i
  açılışta denetlenir.
- **İş sayfası:** Agent fiat işi açıkken kabul eder. Kurum adımları şunlardır:
  - Ödemeden önce politikayı prover'da denetler. Ödeme alınıp ispat bağlanamazsa para iade edilemez.
  - Kartla öder: Stripe Elements, `confirmCardPayment`, 3D Secure dahil. Kayıtlı kartla da ödeyebilir.
  - Makbuzu ve MPP authority'nin attestation'ını görür.
  - İspatı makbuz commitment'ıyla üretip `verify_mpp_payment_proof` ile tek adımda bağlar.
  - Herkes `finalize_fiat_payment` ile işi `Released` yapabilir.
  - Fiat işte dispute, Travel Rule, alacak ve challenge bölümleri gösterilmez.
- **Hesap sayfası:** Kurumun kartı SetupIntent ile kaydedilir; Square kartı Stripe'ın webhook'uyla kaydeder.
- **Paneller:** Fiat işler kasada ve release bekleyen USDC'de sayılmaz. Kurum panelinde kartla ödenen toplam gösterilir.
- **Smart account:** Ed25519 precompile vault mesajına girmez, yürütmenin hemen önüne konur. Bu yüzden yalnızca tek
  başına yürütebilen üyeyle gönderilir.
- **API hataları:** `SquareApiError` zarfın `details`'ini taşır.
