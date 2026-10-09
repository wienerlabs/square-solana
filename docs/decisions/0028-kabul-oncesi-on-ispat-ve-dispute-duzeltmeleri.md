# ADR 0028: Kabul öncesi uyum ön-ispatı, dispute'ta bond ve ret oyu

- **Durum:** Kabul edildi
- **Issue:** P-01 (#236); ADR 0016'nın açık noktaları (#234)
- **Karar kaynağı:**
  - BC-39 iç incelemesinin P-01 bulgusu ([review-bc-39.md](../security/review-bc-39.md));
  - #234 ile ADR 0016'ya yazılan üç açık nokta;
  - proje sahibinin yönlendirmesi (2026-10-07): "proje için en uygun ve en doğru olan".
- **Değiştirdiği karar:**
  - [ADR 0013](0013-release-keeper-ucreti-iade-ve-itibar.md) madde 2 değişmez; bu ADR madde 2'nin önkoşulunu ekler.
  - [ADR 0016](0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md) Karar 1 (ilk oy kararı sabitler) ile Karar 7'nin
    bond kuralı bu ADR'yle değişir.
- **Kapsam:**
  - `programs/square-verifier`: ön-ispat talimatı ve hesabı;
  - `programs/square-escrow`: `accept_job`, `create_job`, `create_fiat_job`, `execute_resolution`,
    `resolve_dispute`;
  - `crates/square-common`;
  - SDK, policy ve agent-sdk;
  - program ve API sözleşmeleri.

## Bağlam

- **P-01 (yüksek):**
  - Kalıcı ret bitleri politikanın gizli parametrelerinden gelir: işlem başı tavan, mint listesi, engelli adres;
    sayaç 0 iken günlük tavanlar (ADR 0013 madde 2). Bunları kurum işi açmadan önce seçer.
  - Agent `accept_job`'da yalnızca commitment'ı ve public tavanı görür.
  - Teslimden sonra kurum geçerli bir kesin ret bağlayıp neti geri alabilir; agent'ın zincirde başvurusu yoktur.
- **Release ispatının girdileri** (`set_compliance_proof`): Verifier public input'ları job'dan kurar:
  - politika commitment'ı ve public tavan job'un açılıştaki anlık görüntüsüdür (`job.policy_commitment`,
    `job.policy_daily_ceiling`);
  - job adresi, payee, net, mint, sayaç ve an.

  Aynı job, aynı net, mint ve payee için kalıcı bitler bu yüzden her ispatta aynıdır; sonradan politika
  güncellense de değişmez.
- **ADR 0016'nın açık noktaları (#234):**
  1. **Bond:** FavorAgent'ta bond payee'ye kesilir. Kesin retle escrow kuruma dönse de `execute_resolution` payee'nin
     temiz kaydını ister. Payee `Flagged` ise iade de bond da süresiz kilitli kalır.
  2. **Günlük tavan bandı:** Karar tam `amount`'u, finalize `amount − ücret`'i öder.
     `amount − ücret ≤ tavan < amount` bandında kurum, sayaç 0'dayken ispat bağlayarak panelin kararını iadeye
     çevirebilir.
  3. **İlk oy:** İlk oy kararı sabitler. Tek bir arbitrator kararı kilitleyip dispute'u lapse'e götürebilir; çare
     yalnızca admin'in `update_arbitrators`'ıdır.

## Değerlendirilen seçenekler

**P-01:**
- **Kabul öncesi ön-ispat:** Kurum, agent kabul etmeden önce işin kendi koşullarıyla uyumluluk ispatı bağlar.
  - Kalıcı bitlerin olmadığı zincirde kanıtlanır.
  - Gizli parametreler commitment'la sabit olduğu için sonradan kalıcı ret çıkamaz.
  - Maliyet: kurum için bir ispat ve bir tx.
- **Kesin retten sonra dispute penceresi:** Agent kesin rete itiraz edebilir.
  - Arbitrator'lar politikanın gizli parametrelerini göremez, bu yüzden retin adil olup olmadığına karar
    veremez.
  - Ödemeyi geciktirir, güveni panele taşır.

**İlk oy:**
- **Ret oyu:** Bir arbitrator bekleyen öneriye ret verebilir.
  - Ret sayısı önerinin eşiğe ulaşmasını imkânsız kılınca öneri düşer, yeni bir öneri açılabilir.
  - Tek bir üye ne kararı dayatabilir ne de engelleyebilir.
- **Yalnızca admin'in arbitrator değişikliği:** Bugünkü çare. Merkezi; ekibin hızına bağlı.

## Karar

1. **Kabul öncesi ön-ispat (policy'li iş):**
   - **Talimat:** Verifier'a `set_preflight_proof` eklenir. Aynı release devresi kullanılır. Verifier public
     input'ları şöyle kurar:

     | Girdi | Değer |
     |---|---|
     | net | `job.amount` (işin tam tutarı: hem finalize'ın hem dispute kararının üst sınırı) |
     | mint | `job.mint` |
     | payee | `job.agent_wallet` |
     | sayaç | 0 |
     | an | kurumun beyanı, ADR 0012 toleransıyla |
     | makbuz | 0 |

     Politika commitment'ı ve public tavan job'un anlık görüntüsüdür.
   - **Kabul koşulu:** Ret kodunda kalıcı bit ya da günlük tavan biti yoksa ön-ispat
     `PreflightProof` PDA'sına (`["preflight_proof", job]`) yazılır. Zaman penceresi ve kategori bitleri geçici
     sayılır, ön-ispatı engellemez. Kalıcı bitli ön-ispat reddedilir.
   - **Escrow:** `accept_job` policy'li işte geçerli bir `PreflightProof` ister. Sahibi verifier olmalı, job bu
     job olmalı, commitment job'unki olmalı. Yoksa `PreflightRequired`. Fiat iş (ADR 0024) de policy'lidir, aynı
     kural geçerlidir.
   - **Sonuç:** Agent'a ödenecek her release'te net `≤ job.amount`, payee aynı agent cüzdanı, sayaç ≥ 0'dır. Kalıcı
     bitler (ve sayaç 0 iken günlük bitler) bu yüzden çıkamaz. Kesin ret yalnızca alacak satılıp payee alıcı
     olduğunda mümkündür; alıcı alıcı listesinin kökünü ve bu riski fiyata katar (ADR 0014).
2. **Public tavan, açılışta:** `create_job` ve `create_fiat_job` policy'li işte `amount > policy_daily_ceiling`'i
   `AmountAboveDailyCeiling` ile reddeder. Ön-ispatın da reddedeceği işi erkenden durdurur.
3. **Bond ve payee taraması:**
   - Agent payı 0 olan bir kararda (FavorAgent + kesin ret ya da Split'te agent payı 0) iade payee taramasını
     beklemez.
   - Bond'un yolu payee'nin kaydına göre:

     | Payee'nin kaydı | Bond |
     |---|---|
     | Temiz ve taze | Payee'ye ödenir |
     | `Flagged` | Kuruma döner; yaptırımlı adrese ödeme yapılamaz, kilit süresiz kalmaz |
     | Süresi dolmuş ya da hiç yapılmamış | Bekler (`ScreeningRequired` / `ScreeningExpired`); agent kaydını yeniletebilir |
   - Agent payı sıfırdan büyükse ADR 0013 madde 3 aynen geçerlidir: ödeme payee'nin temiz kaydını bekler.
4. **Ret oyu:**
   - `resolve_dispute`'a ret verilebilir: `DisputeVote::Reject`, ya da bekleyen öneriden farklı bir karar ret
     sayılır.
   - Retler ayrı bir maskede sayılır. Aktif arbitrator sayısından ret sayısı çıkınca eşik `M`'ye ulaşılamıyorsa
     öneri, onay ve ret maskeleri sıfırlanır. Sonraki oy yeni bir öneri açar.
   - Bir arbitrator aynı öneriye bir kez oy verir; yeni öneride yeniden oy verebilir.
   - Son tarih ve lapse ADR 0016'daki gibidir. Arbitrator setinin sürümü artınca maskeler yine sıfırlanır.
   - Ret maskesi `Job` hesabının sonuna eklenir (ADR 0024 `rail` alanındaki gibi). Alan gelmeden açılmış işler
     dolgu baytlarını 0 okur.
5. **Sözleşmeler:**
   - Program sözleşmesi MINOR artar:
     - talimat `set_preflight_proof`;
     - hesap `PreflightProof`;
     - hatalar `PreflightRequired` ve `AmountAboveDailyCeiling`;
     - `DisputeVote` ve `Job` ret maskesi.
   - API sözleşmesi IDL'den üretilen şemalarla MINOR artar.
   - Devnet'e Squads upgrade'iyle çıkar.

## Gerekçe

- **Madde 1:**
  - Commitment job'un açılışta alınan anlık görüntüsüdür ve release ispatına girer. Ön-ispat bu yüzden aynı
    koşullardaki her sonraki ispatın kalıcı bitlerini bağlar. Güven bir panele değil devreye dayanır.
  - Net olarak tam tutarın seçilmesi iki ödeme yolunu da kapsar: finalize `amount − ücret`'i, dispute kararı
    `amount`'a kadarını öder. Tavan karşılaştırmaları tutarla monotondur.
  - Sayaç 0 ile ispat, günlük tavan bitlerinin yalnızca tutardan gelip gelmediğini ayırır: kalıcı mı, geçici mi.
  - Dispute penceresi seçeneği reddedildi: arbitrator'lar gizli parametreleri göremez.
- **Madde 2:** Public tavan zaten zincirde. Ön-ispattan önce ucuz bir red, kurumu boş bir işin rent'inden de
  korur.
- **Madde 3:** Yaptırımlı adrese ödeme yapılamaz. Süresiz kilit hem kurumun iadesini hem bond'u boşuna bağlar.
  Bond'un kuruma dönmesi yalnızca kesin `Flagged` kaydında olur; yenilenebilir durumlar ödemeyi bekletir.
- **Madde 4:** M-of-N'in anlamı, hiçbir tek üyenin kararı tek başına belirleyememesi ya da engelleyememesidir.
  İlk oyun sabitlemesi bunu ihlal ediyordu; çare yalnızca admin'deydi.

## Sonuçlar

- ADR 0016'nın açık noktalarından üçü bu ADR'yle karara bağlanır: bond ve payee taraması, günlük tavan farkı, ilk
  oy.
- **Uygulama:**
  - P-01 (#236): madde 1 ve 2;
  - dispute düzeltmeleri: madde 3 ve 4, ayrı issue.

  Her biri program sözleşmesinin MINOR'unu artırır ve devnet'te Squads upgrade'i ister.
- **İstemciler:**
  - Kurum aracı (web, CLI, policy paketi) işi açtıktan sonra ön-ispatı bağlar.
  - agent-sdk ön-ispatı olmayan işi kabul etmez (zincir de etmez).
  - Arbitrator konsolu ret oyunu sunar.
- **Agent cüzdanının değişmesi** (P-01'in incelemesi, #262):
  - `PreflightProof` bağlamadaki `job.agent_wallet`'ı (`payee`) saklar. `accept_job` onun işin güncel cüzdanı
    olmasını ister; değilse `PreflightRequired`. Ön-ispattan sonra cüzdan `sync_agent_wallet` ile taşınırsa kurum
    ön-ispatı yeni cüzdan için yeniden bağlar.
  - Kabulden sonraki `sync_agent_wallet` agent'ın kendi eylemidir. Ön-ispatın güvencesi yeni cüzdanı kapsamaz:
    yeni cüzdan politikanın engelli listesindeyse release kesin ret alır ve net kuruma döner.
  - agent-sdk kayıtta cüzdan değişince kaydın kapanmamış policy'li işlerini bildirir (`register`,
    `openPolicyJobs`). Web'in iş sayfası başka cüzdan için bağlanmış ön-ispatı söyler ve kabulü açmaz.

## Açık noktalar

- Ön-ispatın ücreti kurumdadır. Fee payer'ın (ADR 0019) izin listesine `verifier:set_preflight_proof` eklenir.
