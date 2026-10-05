# ADR 0013: Release: keeper ücreti, iade eden ret ve itibar

- **Durum:** Kabul edildi
- **Issue:** BC-23 (#31), BC-24 (#32), BC-26 (#34)
- **Karar kaynağı:** program arayüzü §8 açık noktalar 1, 5, 7 ve 8 ("ilgili issue'nun ADR'ında doğrulanmalı
  ya da değiştirilmelidir"), 2026-10-05
- **Kapsam:** `programs/square-escrow` (`finalize_payment`, `config_rules`, `release_gate`),
  `crates/square-common` (`release::is_final_refusal`)

## Bağlam

- `finalize_payment` sözleşmede tek talimattır ([program arayüzü](../design/program-interface.md) §6,
  §10.4). Bu talimat şunları birlikte yapar: keeper ücreti (BC-23), ispat kapısı (BC-24), payee
  screening'i (BC-27), itibar ve validation kaydı (BC-26).
- Sözleşme dört noktayı bu issue'ların ADR'ına bırakır (§8):
  1. Ret semantiği: hangi `refusal_code`'ların iade, hangilerinin bekleme olduğu.
  5. Payee screening başarısızlığı: release'te payee kaydı temiz değilse ödeme bekler.
  7. Keeper ücretinin üst sınırı.
  8. Aynı token hesabının birden çok rolde geçmesi (Anchor 1.2.0 yinelenen yazılabilir hesabı reddeder).
- Release devresi her çiğnenen kuralı ayrı bit olarak verir ([release-circuit.md](../design/release-circuit.md)
  §3). Aynı belge, kurumun kendi lehine üretebildiği retleri ayrıca ele alır:
  - Günlük tavan bitleri (1, 6) ve zaman penceresi biti (5) kurumun zamanlamasına bağlıdır.
  - Kategori biti (4) tamamen kurumun beyanıdır: `payment_category` ne public sinyaldir ne de zincirde bir
    şeye bağlıdır.
- Arc (`wienerlabs/square`, `docs/decisions/proof-required.md`): ispat yoksa ya da doğrulanamıyorsa escrow
  bekler; iadeyi yalnızca politikanın kendi reddi yapar. Arc'ta ret, sebebinden bağımsız iade eder; geçici
  retleri bekleyip sonra bağlamak kurumun yazılımının görevidir (`proof-freshness.md`).
- Arc'ın keeper ücreti (`keeper-economics.md`): varsayılan 50 bps; tablo 25, 50 ve 100 bps için başa baş
  noktalarını verir. Ücret, işi kapatanın ödediği maliyeti karşılamak içindir.

## Karar

1. **Keeper ücreti:** `amount × keeper_fee_bps / 10 000`, aşağı yuvarlanır, her dalda (ödeme ya da iade)
   finalize'ı çağırana ödenir. `keeper_fee_bps` en fazla `MAX_KEEPER_FEE_BPS = 100` (%1); üstü
   `InvalidKeeperFee`. Net, `amount − ücret`'tir.
2. **İade eden ret** (`square_common::release::is_final_refusal`): Ret kodunda kalıcı bir sebep varsa
   escrow neti kuruma iade eder. Kalıcı sebepler:
   - bit 0 (işlem başı tavan), bit 2 (mint), bit 3 (engelli payee);
   - ispattaki sayaç 0 iken bit 1 ya da 6 (günlük tavanlar): net tek başına tavanı aşıyordur.

   Kalıcı sebep yoksa ret beklemeye döner: `ProofRequired`, escrow bekler. Bu kapsamda kalanlar:
   - sayaç 0 değilken günlük tavan bitleri;
   - zaman penceresi biti (5);
   - kategori biti (4), tek başına ya da yalnızca geçici bitlerle birlikte.

   Kurum uyumlu bir ispat bağlayınca ödenir. Kalıcı bir bitle birlikte gelen geçici bitler iadeyi
   engellemez.
3. **Payee screening:** Ödeme dallarında payee'nin kaydı temiz ve taze olmalı. Payee, alacak satıldıysa
   alıcı, değilse agent cüzdanıdır. Değilse `ScreeningRequired` / `ScreeningFlagged` / `ScreeningExpired`
   döner ve escrow bekler; iade yapılmaz. İade dalında payee screening'i aranmaz.
4. **İtibar ve validation:**
   - İtibar her zaman job'un `AgentRecord`'una yazılır, alacak satılmış olsa da.
   - Ödemede `jobs_completed` bir artar, `total_earned`'e net eklenir.
   - Kesin ret agent'ın tamamladığı iş sayılmaz. `jobs_failed` de artmaz: retlerin çoğu kurumun
     politikasından ya da job'un koşullarından gelir (tutar, mint). Retin sebebi validation kaydındadır.
   - `last_job_at` her release'te güncellenir. `jobs_failed` ve `jobs_disputed` dispute kararlarıyla
     (BC-32) ilerler.
   - Her release `ValidationRecord` yazar: `NoGate`, `Verified` ya da `Refused` + ret kodu.
5. **Aynı token hesabı birden çok rolde:** `payee_token_account` ve `keeper_token_account` `dup`
   kısıtıyla işaretlidir. Keeper, agent ya da kurumun kendisi olabilir. `rent_payer` da `dup`'tur; rent'i
   ödeyen sponsor finalize'ı çağırabilir. Token hesapları escrow'un verisi olmadığı için yinelenme yazma
   çakışması doğurmaz.
6. **Kapı hesapları:** Policy'li işte `release_proof` başlatılmamışsa ya da hiç geçilmemişse sonuç
   `ProofRequired` (bekler).
   - **Sahtelik denetimleri:**
     - adres `["release_proof", job]` değilse `ConstraintSeeds`;
     - verifier'a ait değilse, başka bir job'un ya da politikanın ispatıysa ya da tüketilmişse
       `InvalidReleaseProof`;
     - sayaç hesabı kurumun `["operator_state", institution]`'ı değilse `InvalidReleaseProof`;
     - program config'teki verifier değilse `LinkedProgramMismatch`.
   - **Tazelik:** Taze olmayan ispat `StaleReleaseProof` alır ([ADR 0012](0012-ispat-tazeligi-ve-gunluk-sayac.md)).
   - **CPI:** Uyumlu ödeme de kesin ret de verifier'ın `record_release`'ini çağırır. Ödemede sayaç ilerler,
     retta yalnızca ispat tüketilir.
7. **Vault:** Vault'a fonlamadan sonra gelen fazla token, vault kapanabilsin diye kuruma döner. Vault'un
   rent'i `job.rent_payer`'a döner. İtibar ve validation PDA'larının rent'ini keeper öder (sözleşme §2).

## Gerekçe

- **Kalıcı/geçici ayrımı:** release-circuit.md §3'ün tablosuna dayanır.
  - Ret iade ettiği için ispatı yapan kurumdur ve iade de kuruma gider. Kurumun zamanlamayla ya da beyanla
    üretebildiği bir ret iadeye yol açarsa, kurum teslim edilmiş her işin parasını geri alabilir. Arc'taki
    #346 sorunu, burada politika kılığında yeniden açılmış olur.
  - Kalıcı bitler kurumun elinde değildir: tutar, mint ve payee job'dan ve alacaktan, tavan ve listeler
    job'un policy anlık görüntüsünden gelir.
  - Sayaç 0'dayken günlük tavan biti, netin tek başına tavanı aştığını gösterir; bekleme onu
    düzeltmez.
- **Kategori:** Arc kategoriyi job'a zincir dışında bağlıyordu. Burada sözleşmede bir bağ yoktur
  (release-circuit.md §9). Kategoriye zincirde bir bağ gelene kadar (sözleşme değişikliği) kategori reddi
  tek başına iade etmez.
- **Ücret tavanı:** %1, Arc'ın tablosundaki en yüksek oran ve varsayılanın (0,5) iki katıdır. Tavan,
  admin'in agent'ın ödemesinden kesebileceği payı sınırlar. Solana'da keeper'ın maliyeti işlem ücreti ve
  iki PDA'nın rent'idir; %1, 250 USDC'lik bir işte 2,5 USDC eder. Bu ADR'ın seçimidir: kaynakta Solana için
  bir tavan yoktur.
- **Kesin ret ve `jobs_failed`:** Kaynakta bir kural yoktur. Covenant'ta `jobs_failed`, teslim süresini
  kaçıran agent içindi. Sözleşmede `cancel_job` itibar hesabı almadığı için bu yol kalmadı. Retin
  sebebi agent'ın işi değil çoğu zaman kurumun politikasıdır; sayaç bunu ayırt edemediği için retler
  itibarda sayılmaz, validation kaydında ayrıntısıyla durur.

## Sonuçlar

- Uygulama ve testler:
  - Kod: `programs/square-escrow/src/instructions/finalize_payment.rs`, `src/release_gate.rs`; kural
    `crates/square-common/src/release.rs`.
  - `tests/programs/tests/finalize.rs`: policy'siz işler, keeper, alacak, screening, itibar.
  - `tests/programs/tests/release_gate.rs`: üç dal, geçici ret, bayat ve sahte ispat; gerçek Groth16
    ispatlarıyla.
- Kurumun yazılımı (`@squaresdk/solana-policy`) geçici bir reddi bağlamaz, bekler ve uyumlu ispatı bağlar.
  Kesin reddi bağlamak escrow'u kuruma iade eder.
- Taslak `escalate_missing_proof` (§7) BC-33'te: kurum ispatı hiç bağlamazsa ya da yalnızca geçici ret
  bağlarsa, agent'ın başvuru yolu dispute'tur.

## Açık noktalar

- Kararı verilmiş dispute'ta (`execute_resolution`) kapı: BC-32. Split'te agent tarafının tutarı karardan
  sonra bilinir; ispatın `Resolved` işe bağlanması orada kesinleşir (ADR 0012, açık noktalar).
- Kategori reddinin kalıcı sayılabilmesi için kategorinin job'a zincirde bağlanması: sözleşme değişikliği.
