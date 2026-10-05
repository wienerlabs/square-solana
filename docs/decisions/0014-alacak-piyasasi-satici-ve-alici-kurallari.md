# ADR 0014: Alacak piyasası: satıcı, alıcı ve onaylı liste kuralları

- **Durum:** Kabul edildi
- **Issue:** BC-25 (#33)
- **Karar kaynağı:** BC-25 iş kalemleri 1–3 ve kabul kriterleri; program arayüzü §3, §4, §5 "Alıcı listesi
  Merkle ağacı" ve §6; 2026-10-05
- **Kapsam:** `programs/square-escrow` (`list_claim`, `buy_claim`, `cancel_claim`, `finalize_payment`),
  alım akışını kuran istemciler (`@squaresdk/solana-sdk`, `@squaresdk/solana-policy`, FE-08)

## Bağlam

- **Covenant'ın alacak piyasası** (`covenant/programs/covenant/src/instructions/`):
  - `list_claim`: yalnızca işi alan, teslim edilmiş ve dispute'u olmayan işte, `0 < price < face_value`.
  - `buy_claim`: satıcı ve işi açan dışında herkes alır; fiyat satıcıya hemen gider.
  - `cancel_claim`: yalnızca satıcı, yalnızca satılmamış listeleme.
  - Alıcı uygunluğu yoktur; cüzdan job'da değişmez.
- **Sözleşme** ([program arayüzü](../design/program-interface.md)):
  - Kurum onaylı alıcıları salt'lı bir Merkle köküyle taahhüt eder (`Policy.buyer_root`).
  - `buy_claim` kökü politikanın güncel hâlinden okur. Policy'siz iş ve 32 sıfır baytlık kök kısıtsızdır.
  - Alıcının screening kaydı temiz ve taze olmalı. Fiyat listelemeninkiyle aynı olmalı (öne geçme
    koruması).
  - `ClaimListing.seller` listeleme anındaki `job.agent_wallet`'tır.
  - Payee, alacak satıldıysa alıcı, değilse agent cüzdanıdır. İspat bağlama ve ödeme aynı kuralı kullanır.
- **Solana tarafında hazır olanlar:**
  - Zincirdeki screening kaydı (BC-27): yaptırım taraması alıcıyı alımda, payee'yi release'te denetler
    ([ADR 0013](0013-release-keeper-ucreti-iade-ve-itibar.md) §3).
  - Release ispatı payee'ye bağlıdır; ispatı agent'a bağlanmış işin alacağı satılırsa ispat bayatlar
    ([ADR 0012](0012-ispat-tazeligi-ve-gunluk-sayac.md)).
  - Engelli payee (bit 3) kesin rettir ve escrow'u kuruma iade eder (ADR 0013 §2).
- **Sözleşmenin karşılamadığı iki durum:**
  - Agent cüzdanı `sync_agent_wallet` ile değiştiğinde satılmamış listeleme ne olur?
  - İşi fonlayan kurum alıcı olabilir mi? Sözleşmede bunun için bir kural yok.

## Karar

1. **`list_claim`:**
   - İmzacı `job.agent_wallet` olmalı (`AgentMismatch`), iş `Delivered` olmalı (`InvalidStatus`).
   - Challenge penceresinin açık ya da kapanmış olması fark etmez.
   - `0 < price < job.amount` olmalı (`InvalidClaimPrice`).
   - Job başına tek listeleme vardır (`["claim", job]`). Rent'i `payer` öder ve `rent_payer`'a kaydedilir.
2. **`buy_claim`:** Denetimler bu sırayla yapılır, para ancak hepsi geçince hareket eder:
   1. İş `Delivered` (`InvalidStatus`); listeleme `Listed` (`InvalidClaimStatus`).
   2. Listelemenin satıcısı job'un güncel agent cüzdanı olmalı; değilse `InvalidClaimStatus`.
   3. Fiyat listelemeninkiyle aynı (`ClaimPriceChanged`).
   4. Alıcı satıcı (`BuyerIsSeller`) ya da işin kurumu (`Unauthorized`) olamaz.
   5. Policy'li işte geçilen policy hesabı job'un policy'si olmalı; policy'siz işte policy hesabı
      geçilmez (`PolicyMismatch`).
   6. Alıcının Merkle kanıtı politikanın güncel `buyer_root`'unu tutmalı (`BuyerNotEligible`).
   7. Alıcının screening kaydı temiz ve taze olmalı.

   Sonra fiyat alıcıdan satıcıya aktarılır, listeleme `Bought` olur.
3. **Onaylı liste:**
   - Kök, alım anında politikanın güncel hâlinden okunur; politika etkin olmasa da okunur. Liste
     değişince önceki satışlar geçerli kalır.
   - Sıfır kök sözleşmedeki gibi kısıtsızdır, policy'li işte de. Policy'siz işin listesi yoktur.
4. **`cancel_claim`:** Yalnızca satıcı, yalnızca `Listed` listelemeyi geri çeker. Hesap kapanır, rent
   `rent_payer`'a döner, alacak yeniden listelenebilir. Satılmış ve settlement'ta kapanmış (`Settled` /
   `Defaulted`) listelemeler kayıt olarak kalır.
5. **Settlement:** `finalize_payment` listelemeyi okur, satılmışsa alıcıya öder. Ödeme dalında
   listeleme `Settled`, iade dalında `Defaulted` olur. İtibar agent kaydına yazılır (ADR 0013).

## Gerekçe

- **Satıcı güncel cüzdan olmalı:** Bu ADR'ın seçimidir; Covenant'ta cüzdan değişmez.
  - `sync_agent_wallet` cüzdan rotasyonu içindir (ör. anahtarın kaybı ya da ele geçirilmesi).
  - Eski cüzdanın listelemesi satılabilseydi fiyat job'un artık tanımadığı cüzdana giderdi, alacak ise
    alıcıya geçerdi.
  - Bedeli: eski anahtar kayıpsa listeleme geri çekilemez ve alacak bir daha listelenemez. Escrow yine
    yeni cüzdana ödenir, çünkü satılmamış alacakta payee `job.agent_wallet`'tır.
- **Kurum alıcı olamaz:** Covenant'ın gerekçesi. Kurum alırsa escrow'u kendine yönlendirir, sonra
  dispute'la agent'ı sıkıştırabilir.
- **Güncel kök:** Sözleşmenin `buy_claim` dokümanı ("checked against the current `policy.buyer_root`").
  Satış alım anında değerlendirilir. Ödeme yine release ispatından geçer, ispat payee'ye bağlıdır.
- **Sıfır kök kısıtsız:** Sözleşme (v0.2.0) kuralı koyar ama gerekçe yazmaz; aşağıdaki gerekçe bu
  ADR'ındır.
  - Solana'da alıcı, listeden bağımsız olarak alımda zincirdeki screening kaydından geçer. Payee olarak
    release'te bir kez daha geçer. Temel uyum denetimi böylece alımdadır.
  - Liste kurumun ek seçimidir. Kurum yalnızca onayladığı alıcıların almasını istiyorsa listeyi
    `set_buyer_root` ile yayımlar. Politika editörü (FE-04) boş listeyi sıfır kök olarak yazar.
  - Kalan risk: Kök sıfırken kurumun politikasında engelli bir adres alacağı alırsa release kesin retle
    iade eder (bit 3) ve alıcı ödediği fiyatı kaybeder. Bu riski kurum listeyi yayımlayarak kaldırır.
    Alıcıya ise alım akışında gösterilir (Sonuçlar).
- **`Delivered` ve fiyat sınırı:** Covenant'ın kuralları; sözleşme dokümanı da "on a delivered job" der.
  Yüz değer ve üstündeki fiyatla alan alıcı, release'te ödediğinden fazlasını alamaz.

## Sonuçlar

- **Uygulama:**
  - `programs/square-escrow/src/instructions/{list_claim,buy_claim,cancel_claim}.rs`.
  - Listenin okunması: `src/linked.rs` (`buyer_root`).
  - Kanıt doğrulaması: `square_common::merkle`.
- **Testler** (`tests/programs/tests/claim.rs`):
  - Liste ve kanıt kuralları, en derin liste (16 kardeş, tek işlem).
  - Sıfır kök ve policy'siz iş.
  - Satıcı, kurum, screening ve token hesabı denetimleri.
  - Cüzdan rotasyonu, geri çekme ve settlement.
- **Mevcut testler:** Satılmış alacakta release testleri (`finalize.rs`, `release_gate.rs`, `verifier.rs`)
  alacağı gerçek `list_claim` / `buy_claim` ile satar.
- **İstemciler (SDK, FE-08):**
  - Policy'li işte kök sıfırken alıcıya riski gösterir: kurumun politikası onu engelliyorsa release iade
    eder.
  - Cüzdan rotasyonundan sonra eski listeleme eski cüzdanla geri çekilmeden yenisi açılamaz.
  - Satıcı kendi ATA'sıyla alamaz: aynı yazılabilir hesap iki rolde geçer ve Anchor reddeder (2040).
