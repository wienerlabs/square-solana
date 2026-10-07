# ADR 0016: M-of-N arbitration, dispute zaman aşımı ve ispatsız bekleme

- **Durum:** Önerildi
- **Issue:** BC-32 (#69), BC-33 (#70)
- **Karar kaynağı:** BC-32 ve BC-33 iş kalemleri ve kabul kriterleri; program arayüzü §7 "M-of-N
  arbitration", "Dispute timeout", "İspatsız bekleme" taslakları ve §8 açık noktaları 2, 3 ve 6;
  [R2](../analysis/square-solana-analysis.md#10-riskler); 2026-10-06
- **Kapsam:** `programs/square-escrow` (`raise_dispute`, `resolve_dispute`, `execute_resolution`,
  `update_arbitrators`, `lapse_dispute`, `escalate_missing_proof`, `update_params`), `programs/square-verifier`
  (`set_compliance_proof`'un iş durumu), sözleşme v0.5.0

## Bağlam

- **Covenant'ta (R2):** arbitrator seti sabit üç slottur (2-of-3) ve `Disputed` durumundan çıkış yoktur.
  Arbitrator'lar oy vermezse escrow ve bond kalıcı olarak kilitlenir.
- **Sözleşmedeki taslak** ([program arayüzü](../design/program-interface.md) §6, §7):
  - Arbitrator seti N ≤ 7 ve 2 ≤ M ≤ N; onaylar `u8` bit maskesi, set değiştikçe
    `arbitrator_set_version` artar ve dispute bir sürüm saklar.
  - Dispute iki adımlıdır: `resolve_dispute` yalnızca oyu kaydeder, ödemeyi `execute_resolution` yapar.
  - `lapse_dispute` `dispute.deadline`'dan sonra bond'u iade eder ve işi `Delivered`'a döndürür.
  - `escalate_missing_proof`, policy'li işte `challenge_end + proof_timeout_secs` sonrasında bağlı ispat
    yoksa agent'a bond'suz dispute açar.
- **Taslağın açık bıraktıkları** (§8):
  - (6) aktif dispute sırasında set değişirse oyların hangi sete göre sayılacağı;
  - (2) kurumun ispatı hiç bağlamayarak ödemeyi süresiz bekletmesine karşı kural;
  - (3) dispute'ta ispatın kapsamı ve bond'un kapıdan geçip geçmediği.
- **Verifier'daki kısıt:** `set_compliance_proof` yalnızca `Delivered` ve `Disputed` işe ispat bağlıyordu.
  İspat yalnızca bağlandığı UTC gününde tazedir ([ADR 0012](0012-ispat-tazeligi-ve-gunluk-sayac.md)) ve
  ödenecek tutar karar verilmeden bilinmez. Bu yüzden policy'li işte FavorAgent ya da Split kararı ödenemezdi.

## Karar

1. **M-of-N:** Set en fazla 7 üyedir; üyeler tekrar etmez ve boş anahtar olamaz; eşik `2 <= M <= N`'dir.
   Aynı kural `init_config` ve `update_arbitrators`'ta uygulanır. Bir arbitrator bir dispute'ta bir kez oy
   verir (bit maskesi). İlk oy kararı belirler, sonraki oylar ona eşit olmalıdır (`ResolutionMismatch`).
   `Pending` bir oy değildir, `Split.agent_amount` escrow'u aşamaz. M oya ulaşınca iş `Resolved` olur.
   **Değişti:** [ADR 0028](0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 4 (program sözleşmesi
   v0.8.0): ilk oy bir öneri açar, farklı oy ret sayılır ve yeterli ret öneriyi sıfırlar.
2. **Aktif dispute'ta set değişimi:** Oylar oy anındaki sete göre sayılır. Dispute'un saklı
   `arbitrator_set_version`'ı config'ten eskiyse, bir sonraki oy sayımı sıfırlar: maske, sayaç ve bekleyen
   karar düşer, sürüm güncellenir, sonra oy sayılır. Son tarih ve bond değişmez. Karara bağlanmış
   (`Resolved`) bir dispute set değişiminden etkilenmez.
3. **Son tarih:** `deadline = raised_at + dispute_timeout_secs`. `dispute_timeout_secs > 0` ve
   `proof_timeout_secs >= 0` olmalıdır (`InvalidDisputeTimeout`). Oylar `now < deadline` iken kabul edilir.
   `deadline` ve sonrasında yalnızca `lapse_dispute` çalışır.
4. **Lapse:** `lapse_dispute` permissionless'tır. Bond'u (vault'a sonradan gelen fazlası dahil) kuruma iade
   eder ve bond vault'unu kapatır; rent `job.rent_payer`'a gider. İş `Delivered`'a döner ve
   `finalize_payment` yolundan çözülür. Dispute kaydı `lapsed` olarak kalır.
5. **İşte tek dispute:** Kurum bir işte yalnızca bir kez itiraz eder; lapse olmuş dispute da sayılır
   (`DisputeAlreadyRaised`). Bond sıfır olamaz.
6. **İspatsız bekleme başvurusu:** Agent, policy'li ve `Delivered` bir işte `escalate_missing_proof` ile
   bond'suz dispute açabilir. Koşullar:
   - bekleme süresi `challenge_end`'den, önceki dispute lapse olduysa onun kapanışından sayılır;
   - bağlı ispat bugün işi kapatamıyor olmalıdır, yani ispat yoktur, ret geçicidir ya da ispat başka bir
     UTC gününde değerlendirilmiştir.

   Bugün uyumlu bir ispat ya da kesin ret varsa iş zaten finalize edilebilir ve başvuru reddedilir.
   Lapse'tan sonra başvuru tekrarlanabilir. Kurumun ikinci dispute yasağı (madde 5) agent'ın başvurusunu
   etkilemez.
7. **Kararın ödenmesi** (`execute_resolution`, permissionless):
   - **Agent tarafının tutarı:** FavorAgent'ta `amount`, Split'te `agent_amount`, FavorInstitution'da 0.
     Keeper ücreti kesilmez.
   - **Kapı:** Agent tarafı tutarı payee çözümü (alacak satıldıysa alıcı) ve ispat kapısı dahil
     `finalize_payment`'in kurallarından geçer. Uyumlu ispat ödenir. Kesin ret tutarı kuruma iade eder.
     İspat yoksa, ret geçiciyse ya da ispat bayatsa iş bekler.
   - **Bond:** Kapıdan geçmez. FavorAgent'ta agent tarafına kesilir, diğer kararlarda kuruma döner.
   - **Payee kontrolü:** Payee'ye bir şey ödenecekse payee'nin token hesabı ve screening'i (temiz ve taze)
     zorunludur. Değilse ödeme bekler, iade yapılmaz.
   - **Kayıtlar:** `jobs_disputed` her kararda artar. Agent tarafına ödeme varsa `jobs_completed` ve
     `total_earned` artar, FavorInstitution'da `jobs_failed` artar. `ValidationRecord` sonucu `Verified`,
     `NoGate`, `Refused` ya da ödeme yoksa `NoPayout`'tur. Alacak listelemesi ödemede `Settled`, iadede
     `Defaulted` olur.
   - **Kapanış:** Vault ve bond vault'u kapanır; rent `job.rent_payer`'a gider.
8. **Karar sonrası ispat:** Verifier `set_compliance_proof`'u `Resolved` işe de bağlar. Kurum kararın agent
   tarafı tutarı için taze ispatı karar verildikten sonra bağlar.

## Gerekçe

- **Madde 2:** Bit maskesi eski setin sıralarını tutar. Yeni sette aynı sıra başka bir anahtara denk
  gelebilir, bu yüzden eski onaylar yeni sette anlamsızdır ve sayılmaz. Sıfırlama dispute'u bozmaz: son
  tarih korunur, karar çıkmazsa madde 4 fonları serbest bırakır. Kabul kriteri ("set değişimi aktif
  dispute'ları bozmuyor") `tests/programs/tests/dispute.rs`'te test edilir.
- **Madde 3 ve 4:** R2'yi kapatır: karar çıkmazsa ne bond ne escrow kilitli kalır. Sıfır süre her dispute'u
  açıldığı anda lapse edilebilir kılardı ve dispute'u işlevsiz bırakırdı.
- **Madde 5:** Kurumun aynı teslimi tekrar tekrar itiraz ederek ödemeyi bekletmesini önler.
- **Madde 6 ve 7:** Açık nokta 2'nin cevabıdır. Mandate kuralı korunur: policy'li işte agent tarafına
  uyumlu ispat olmadan ödeme yapılmaz. Kurumun ispatı bağlamaması, geçici bir ret bağlaması ya da tazelemeden
  bırakması agent'ı sonsuza kadar bekletemez; agent her durumda arbitrator'lara gidebilir. Arbitrator'lar
  FavorInstitution ya da Split kararıyla escrow'u kapıdan geçmeden çözebilir. Bu kararlar kuruma iade eder
  ya da yalnızca payı ispat ister.
- **Madde 7, bond:** Bond bir cezadır ve agent tarafının hakkıdır; kurumun politikasının ödeme kuralı değildir.
  Bu nedenle kapıdan geçmez (açık nokta 3). Payee screening'i yine de uygulanır: yaptırımlı bir adrese hiçbir
  ödeme yapılmaz.

## Sonuçlar

- **Uygulama:**
  - Talimatlar: `programs/square-escrow/src/instructions/{raise_dispute, resolve_dispute,
    execute_resolution, update_arbitrators, lapse_dispute, escalate_missing_proof}.rs`.
  - Kurallar ve birim testleri: `src/dispute.rs`. Settlement yardımcıları `finalize_payment` ile ortak:
    `src/settlement.rs`.
  - Verifier: `programs/square-verifier/src/linked.rs` (`require_bindable`).
- **Sözleşme v0.5.0:** Yeni hata 6048 `InvalidDisputeTimeout` sona eklendi, mevcut kodların sırası
  değişmedi. Dispute talimatlarının ve alanlarının dokümanları taslaktan çıktı. Escrow'un IDL'i sözleşmeyle
  aynı; `scripts/ci/programs.mjs`'te bekleyen öğesi yok.
- **Testler (LiteSVM):**
  - `tests/programs/tests/dispute.rs`: policy'siz kararlar, lapse, set değişimi, alacak satılmış iş,
    parametre kuralları.
  - `tests/programs/tests/dispute_gate.rs`: ispat kapılı kararlar ve başvuru. Gerçek Groth16 ispatları
    `dispute_*` senaryolarıdır (`circuits/payment-compliance/scripts/program-proofs.mjs --missing`).
- **Bond vault'unun rent'i:** `job.rent_payer`'a döner, `raise_dispute`'un `payer`'ına değil; `Job`'da
  ikinci bir rent ödeyen alanı yoktur. Sponsorlu işlemde iki ödeyen genellikle aynı kurumun fee payer'ıdır.
- **Devnet upgrade'i** (iş kalemi 5 ve 4) BC-30 deploy'una bağlıdır. Squads üzerinden yapılır ve bu ADR
  kapsamında yapılmadı.

## Açık noktalar

- Arbitrator kararının gerekçesi zincirde tutulmaz. Kanıtın saklanması (`reason_hash` ↔ off-chain kanıt) ve
  arbitrator bildirimi BE-22'de uygulandı ([apps/api](../../apps/api/README.md#uyuşmazlık)).
- `lapse_dispute`'un otomatik çağrılması BE-22'de keeper'ın lapse crank'i olarak uygulandı
  ([apps/keeper](../../apps/keeper/README.md#lapse-cranki-be-22)).
- **Kararın ispatsız beklemesi:** Policy'li işte FavorAgent ya da agent payı sıfırdan büyük bir Split kararı,
  kurum uyumlu bir ispat (ödeme) ya da kesin bir ret (iade) bağlayana kadar `Resolved`'da bekler. Kurum
  hiçbirini bağlamazsa escrow ve bond kilitli kalır: `lapse_dispute` `Disputed`, `escalate_missing_proof`
  `Delivered` ister. Bu bilinçli bir tercihtir: agent tarafına ispatsız ödeme yapılmaz ve kurum ispatı vermeyerek
  fonunu geri alamaz, yani bekletmek kuruma bir şey kazandırmaz. Zaman aşımıyla iade ya da ispatsız ödeme yolu
  yoktur.
- **Aynı gün bayatlayan ispat:** `escalate_missing_proof` ispatın yalnızca gününe, tüketilip tüketilmediğine ve
  kararına bakar. `check_fresh`'in payee, net tutar, mint ve günlük sayaç denetimlerini yapmaz, çünkü talimat
  `OperatorState` ve alacak listelemesi hesaplarını almaz. `finalize_payment`'in bayat saydığı aynı günkü bir
  ispat başvuruyu UTC günü bitene kadar engeller. Kurum her gün ispat bağlayıp sayacını başka bir release'le
  değiştirirse bu tekrarlanabilir. Tam denetim bu iki hesabın talimata eklenmesini, yani arayüz değişikliğini
  gerektirir; v0.6.0'da yapılmadı.
- **Alacak alıcısının başvurusu:** Başvuruyu yalnızca `job.agent_wallet` imzalar. Alacak satıldıysa payee
  alıcıdır ve başvuru için agent'a bağlıdır; alıcı bu riski alacağın fiyatına katar.
- **FavorAgent'ta bond ve payee'nin taraması:** FavorAgent kararında bond agent tarafına kesilir. Kurum kesin bir
  ret bağladıysa escrow kuruma döner, ama bond yine payee'ye gittiği için `execute_resolution` payee'nin temiz ve
  taze screening kaydını ister. Payee sonradan `Flagged` olduysa iade de bekler: escrow ve bond, payee'nin kaydı
  temizlenene kadar kilitli kalır (yaptırımlı bir adreste süresiz). `finalize_payment`'te ret payee taraması
  istemez. Bu, Karar 7'nin "ödeme bekler, iade yapılmaz" kuralına uyar; kararın kapsamadığı bir durumdur. Hesap
  düzenini değiştirmeyen bir çözüm (ör. agent payı sıfırken payee temiz değilse bond'u kuruma döndürmek) sahibinin
  kararını bekliyor. **Karar:** [ADR 0028](0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 3.
- **Kararın ve finalize'ın günlük tavan farkı:** Karar agent tarafına keeper ücretsiz tam `amount`'u verir,
  `finalize_payment` ise `amount - ücret`'i öder. İkisi de ispatın net tutarı olarak kapıdan geçer ve devrede iki
  günlük tavan da (özel ve herkese açık) `daily_spent_before + net`'e bakar.
  - Policy'li bir işin tutarı `amount - ücret <= tavan < amount` bandındaysa finalize ödenirdi. FavorAgent
    kararında ise kurum ispatı sayacı 0'ken bağlayarak kesin `DAILY_CEILING` (ya da `DAILY_PRIVATE`) reti alır ve
    escrow iade edilir. İspatın zamanını kurum seçtiği için panelin kararını fiilen tersine çevirebilir.
  - Hesap düzenini değiştirmeyen iki yol var: arbitrator aracı bu bantta FavorAgent yerine
    `Split { agent_amount: tavan }` önerir, ya da `create_job` policy'li işte `amount > tavan`'ı reddeder.
  - **Karar:** [ADR 0028](0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 1 ve 2: kabul öncesi
    ön-ispat tam tutar ve sayaç 0 ile; açılışta public tavan reddi.
- **İlk oy kararı belirler:** Karar 1'e uygun olarak ilk oy kararı sabitler, sonraki oylar aynı olmalıdır
  (`ResolutionMismatch`). Bu yüzden M-of-N tek bir hatalı üyeye dayanmaz. Agent'la anlaşan bir arbitrator ilk oyu
  FavorAgent ya da bir Split olarak verirse başka bir karar oylanamaz. Dispute son tarihte lapse olur ve kurum
  ikinci bir dispute açamaz; policy'siz işte finalize agent'a öder. Sürüm artınca sayım sıfırlandığı için (Karar
  2) çare, son tarihten önce `update_arbitrators`'tır
  ([upgrade runbook'u](../runbooks/upgrade.md#8-olağan-dışı-durumlar)). Kuralın kendisi ayrı bir ADR'de yeniden
  ele alınabilir. **Karar:** [ADR 0028](0028-kabul-oncesi-on-ispat-ve-dispute-duzeltmeleri.md) madde 4 (ret
  oyu).
