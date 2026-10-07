# ADR 0026: Stripe MPP fiat ödemesi: Square'in Stripe hesabı, ödeme yolları, makbuz ve attestation servisi

- **Durum:** Kabul edildi
- **Issue:** BE-25 (#80)
- **Karar kaynağı:**
  - BE-25 iş kalemleri 1–4:
    1. Stripe webhook doğrulama, Poseidon receipt commitment ve ed25519 attestation;
    2. agent off-session kart (SetupIntent);
    3. fiat ödemenin Square job settlement'ına bağlanması (ADR);
    4. `mppx` entegrasyonu.
  - BE-25 kabul kriterleri: "Stripe test modunda ödeme → on-chain MPP ispatı kabul", "Webhook imza ve replay
    testleri".
  - [ADR 0024](0024-stripe-mpp-fiat-rayi.md) açık noktaları: makbuz commitment'ı, birim çevrimi, `mpp_payments`
    ve fiat ispatının yenilenmesi.
  - Issue sahibinin yönlendirmesi (2026-10-07): ödeme hesabı ve tasarım, projeye ve issue'ya en uygun biçimde.
- **Kapsam:**
  - `apps/api`: `src/fiat/`, `src/routes/fiat.ts`, yapılandırma;
  - `db/` (migration `20261007020000_fiat_payments`);
  - `@squaresdk/solana-types` (`fiat`), `@squaresdk/solana-sdk` (API istemcisi);
  - `@squaresdk/solana-policy` (`watchJobProof`);
  - `apps/compliance-api`: Stripe/MPP akışı kaldırıldı;
  - API sözleşmesi v0.24.0.

## Bağlam

- **ADR 0024 sınırı:** Zincir tarafını kurar: vault'suz fiat iş, işe ve tutara bağlı attestation,
  `verify_mpp_payment_proof` ve `finalize_fiat_payment`. Şunları BE-25'e bırakır:
  - Stripe'tan attestation'a giden yol;
  - makbuzun commitment'ı;
  - sentin settlement birimine çevrilmesi;
  - bir makbuzun tek işe bağlanması;
  - fiat ispatının yenilenmesi.
- **Aperture compliance-api'nin akışı:**
  - Webhook `payment_intent.succeeded`'den kanonik makbuz kurulur:
    - alanlar: PaymentIntent, sent, para birimi, müşteri, ödeme anı;
    - Poseidon commitment'ı alınır, ed25519 ile imzalanır.
  - Operatörün kartı SetupIntent ile kaydedilir ve off-session ödemede kullanılır.
  - MPP ile ödenen rapor kendi 402 ara katmanıyla sunulur.
  - Uyumsuzluk: imzalanan mesaj yalnızca commitment'tır, oysa ADR 0024 §3 mesajında job ve tutar da vardır. Bu
    imzayı verifier artık kabul etmez.
- **`mppx`** (wevm, MIT) Machine Payments Protocol'ün sunucu ve istemci uygulamasıdır.
  - Stripe yöntemi (`stripe.charge`) ödeyenin Shared Payment Token'ıyla (SPT) satıcının hesabında PaymentIntent
    onaylar.
  - Challenge, satıcının Stripe profil kimliğini (`networkId`) taşır. HMAC sırrıyla isteğe bağlanır.
  - `mppx` Express ara katmanı Express 5 ister; `apps/api` Express 4'tedir. Çekirdek API Fetch `Request` alır.

## Karar

1. **Hesap ve kapsam:**
   - Fiat ödeme Square'in Stripe hesabına yapılır. Kurum işin tutarını Square'e öder.
   - Agent'a fiat ödeme (Stripe Connect payout) bu kararın dışındadır, ayrı iştir.
   - Para birimi USD'dir (ADR 0024 §7).
   - Tutar işin tutarıdır: settlement mint'inin taban biriminden sente çevrilir; 1 sent = 10^(decimals − 2) birim.
   - Tam sent olmayan ya da Stripe'ın en düşük tutarının (50 sent) altındaki iş ödenmez.
2. **Ödemenin ön koşulları** (her yolda):
   - Job fiat rayında ve `Delivered`.
   - Çağıran job'un kurumunun güncel yetkilisidir: kurum anahtarı ya da Squads multisig'inde öneri açabilen üye.
     Kural Travel Rule ve politika meta verisiyle aynıdır.
   - İşin attestation'ı yoktur.
   - Ödeme, kurumun public günlük tavanını bugünkü sayaçla birlikte aşmaz (`OperatorState`).
   - Kurumun gizli politikası API'ye gelmez. Gizli kurallar ödemeden önce kurumda denetlenir; devre aynı
     kuralları ispatta uygular.
3. **Ödeme yolları:**
   - **Tarayıcı** (`createFiatPayment`, `offSession: false`):
     - PaymentIntent açılır, Stripe.js ile onaylanır.
     - İşin açık PaymentIntent'i yeniden kullanılır.
   - **Kayıtlı kart** (`offSession: true`):
     - Kurumun SetupIntent ile kaydettiği kartla hemen ödenir (`off_session`).
     - Ödeme tamamlanırsa attestation aynı yanıttadır.
     - Red ya da müşterinin onayı gerekirse 402 `payment_failed` döner.
     - Kart `setup_intent.succeeded` webhook'uyla kaydedilir, öncekinin yerini alır.
     - Stripe müşterisi kurum anahtarı başınadır.
   - **MPP** (`payFiatJobMpp`):
     - `mppx` Stripe `charge`; challenge işe bağlıdır: tutar ve `externalId` = job.
     - Ödeyen kurumun ödeme ajanıdır.
     - Kimlik `fiat:pay` kapsamlı API anahtarıdır, çünkü `Authorization` credential'ı taşır.
   - Her yolda PaymentIntent metadata'sı işi ve kurumu taşır. Webhook ve mutabakat ödemeyi bununla tanır.
   - Yeni kapsam: `fiat:pay`. Yeni hata kodları: `payment_required`, `payment_failed`, `payment_unavailable`.
4. **Makbuz ve attestation:**
   - Kanonik makbuz Aperture'ın düzenindedir:
     - receiptHash = Poseidon(alan(PaymentIntent), sent, alan(para birimi), alan(müşteri ?? ""), ödeme anı);
     - alan(s) = Poseidon(s'nin 32'ye sıfırla doldurulmuş UTF-8 baytlarının iki yarısı);
     - ödeme anı son charge'ın anıdır.
   - Makbuz, PaymentIntent Stripe'tan yeniden okunarak kurulur. Olay gövdesine güvenilmez.
   - İmza ADR 0024 §3 mesajı üzerindedir. Anahtar `VerifierConfig.mpp_authority`'nin keypair'idir
     (`API_MPP_AUTHORITY_KEYPAIR`).
   - Attestation üç yoldan yazılır:
     - imzalı webhook;
     - kurumun mutabakat isteği: işin PaymentIntent'leri Stripe'tan okunur;
     - MPP isteğinin kendisi.
5. **Webhook:**
   - Ham gövde `Stripe-Signature`'a karşı doğrulanır; Stripe'ın tolerans süresi 300 saniyedir.
   - İmzası tutmayan ya da eski olay 400 alır.
   - Aynı olay ya da aynı PaymentIntent yeniden gelirse kayıt değişmez.
   - Square'e ait olmayan ödeme ve diğer olaylar kayıtsız 200 alır.
6. **Tekillik:**
   - İş başına bir attestation (`mpp_payments.job` tekil).
   - Attestation'ı olan işe gelen ikinci başarılı ödeme `duplicate` sebebiyle iade edilir.
7. **Rotasyon:** Attestation okunurken imzalayan anahtar yapılandırmadakinden farklıysa güncel anahtarla yeniden
   imzalanır (upgrade runbook'u §7).
8. **İspatın yenilenmesi:**
   - `watchJobProof` fiat işi, verilen attestation okuyucusuyla (`mppAttestation`) izler.
   - İspat bayatlayınca aynı attestation ile yeniden üretilir ve `verify_mpp_payment_proof` ile bağlanır.
   - Attestation her yenilemede yeniden okunur.
9. **compliance-api:** Stripe/MPP akışı Square API'ye taşındı ve compliance-api'den kaldırıldı:
   - webhook, makbuz imzası, agent kartı;
   - doğrulanmış ödeme uçları, Stripe mutabakat izleyicisi;
   - MPP ile ödenen rapor.

   x402 raporu ve Solana izleyicisi kalır.

## Gerekçe

- **Madde 1:**
  - Issue fiat ödemenin Square'in job settlement'ına bağlanmasını ister; ödeme Square'in hesabına yapılır.
  - Agent'a fiat ödeme, agent'ların Stripe hesaplarının bağlanmasını gerektirir. Issue bunu istemez.
  - Tam sent kuralı attestation'daki tutarın job'unkine eşit olmasından gelir: tutar yuvarlanamaz.
- **Madde 2, tavan:** Devre public tavanı aşan ödemeye ret kodu verir. ADR 0024 §4'e göre yalnızca uyumlu ispat
  bağlanır; ödeme alınıp ispat bağlanamazsa para iade edilemez.
- **Madde 3, MPP kimliği:** `mppx` credential'ı `Authorization: Payment` ile taşır. Oturum belirteci aynı başlıktadır.
- **Madde 4:**
  - Commitment düzeni Aperture'ınkidir: devrenin 12. sinyali bu değerdir, kaynak protokolü korunur.
  - Poseidon MIT `poseidon-lite` ile hesaplanır (`@squaresdk/solana-policy`), GPL circomlibjs kullanılmaz.
    Uyum, circomlibjs çıktısıyla aynı test vektörleriyle denetlenir.
- **Madde 6:** ADR 0024 §7'de bir makbuzun yalnızca bir işe attest edilmesi MPP authority'nin kuralıdır.
  İade, ödemenin işe bağlanamayan kısmını kuruma döndürür.
- **Madde 9:** compliance-api'nin imzası verifier'ca kabul edilmez. Aynı authority anahtarı iki serviste
  tutulmaz.

## Sonuçlar

- **Uygulama:**
  - `apps/api/src/fiat/`:
    - `chain.ts`: job, sent çevrimi, tavan;
    - `receipt.ts`: makbuz, attestation;
    - `service.ts`: ödeme, webhook, mutabakat, kart;
    - `mpp.ts`: `mppx`.
  - `apps/api/src/routes/fiat.ts`: webhook ve MPP, `express.json` ve kimlik ara katmanından önce bağlanır.
  - Veritabanı:
    - `mpp_payments`: `authority`, `amount`, `source` alanları; job tekil;
    - `fiat_payment_intents`;
    - `stripe_customers`;
    - `ApiKeyScope.fiat:pay`.
- **Sözleşme v0.24.0:**
  - 8 operasyon;
  - `fiat` etiketi;
  - `fiat:pay` kapsamı;
  - 3 hata kodu.
- **Yapılandırma:**
  - Dört değişken birlikte verilir; verilmezse fiat uçları 503 döner: `API_STRIPE_SECRET_KEY`,
    `API_STRIPE_PUBLISHABLE_KEY`, `API_STRIPE_WEBHOOK_SECRET`, `API_MPP_AUTHORITY_KEYPAIR`.
  - MPP yolu ayrıca `API_MPP_SECRET_KEY` ve `API_MPP_NETWORK_ID`'yi ister (ikisi birlikte). Stripe profili
    hesabın canlı aktivasyonunu ister; profil yoksa yalnızca MPP ucu 503 döner, `FiatConfig.mppNetworkId` null'dır.
- **Bağımlılıklar** (`apps/api`):
  - `stripe`, `mppx` (MIT);
  - `viem`: MIT; `mppx`'in Stripe sunucu girişinin peer bağımlılığı.
- **Testler:**
  - `apps/api/test/fiat.test.ts`: fixture Stripe sunucusu, gerçek `stripe` SDK'sı ve `mppx/client`.
  - `fiat-units.test.ts`.
  - `packages/policy/test/chain.test.ts`: fiat izleme.
  - Devnet ve Stripe test modunda kabul koşusu: `apps/api/test/fiat-devnet.e2e.test.ts`,
    [docs/deploy/fiat-devnet.md](../deploy/fiat-devnet.md).

## Açık noktalar

- MPP'nin gerçek Stripe hesabıyla koşusu Stripe profilini, profil de hesabın canlı aktivasyonunu (kimlik ve banka
  doğrulaması) ister. Aktivasyon hesap sahibinin işidir. O zamana kadar MPP yolu fixture Stripe ve gerçek
  `mppx/client` ile test edilir; devnet kabulü kart yoluyladır ([fiat-devnet.md](../deploy/fiat-devnet.md)).
- Ödenmeyen fiat iş `Delivered`'da kalır (ADR 0024).
- Kurumun gizli politikasının ödemeden önce denetlenmesi kurumun istemcisindedir. Web arayüzü FE-20'dir.
