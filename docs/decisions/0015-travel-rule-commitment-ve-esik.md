# ADR 0015: Travel Rule commitment'ı ve fonlama eşiği

- **Durum:** Kabul edildi
- **Issue:** BC-34 (#71)
- **Karar kaynağı:** BC-34 iş kalemleri 1–3 ve kabul kriterleri ("Eşik üstü fonlama commitment olmadan
  reddediliyor (kural ADR'de)"); program arayüzü §7 "Travel Rule" taslağı; 2026-10-05
- **Kapsam:** `programs/square-escrow` (`commit_travel_rule`, `fund_job`), `crates/square-common`
  (`travel_rule`), `@squaresdk/solana-sdk` (`travelRule`, `flow.commitTravelRule`), Travel Rule kaydının
  saklanması (BE-23)

## Bağlam

- **Issue'nun hedefi:** Kişisel veri zincire çıkmadan, eşiği aşan fonlamalara Travel Rule bilgisinin salt'lı
  commitment'ı bağlanır. Kabul kriterleri:
  - eşik üstü fonlama commitment olmadan reddedilir;
  - zincirde kişisel veri yoktur;
  - commitment doğrulanabilir.
- **Sözleşmedeki taslak** ([program arayüzü](../design/program-interface.md) §7):
  - Alanlar: `EscrowParams.travel_rule_threshold` (0 = kapalı), `Job.travel_rule_commitment` (sıfır = yok).
  - Talimat `commit_travel_rule(commitment)`; imzacı job'un kurumu, hesap yalnızca job.
  - Event `TravelRuleCommitted`, hata `TravelRuleCommitmentRequired`.
  - Taslağın dokümanı: commitment `amount >= threshold` ise `fund_job`'dan önce gerekir.
- **BC-22'de yazılanlar:** `fund_job` bu kuralı denetliyordu ama commitment'ı bağlayan talimat yoktu.
  Eşiği açık bir kurulumda eşik üstü iş fonlanamıyordu.
- **Taslağın açık bıraktıkları:**
  - commitment'ın nasıl hesaplandığı;
  - ne zaman bağlanıp değiştirilebildiği;
  - doğrulayan tarafın elinde ne olması gerektiği.

## Karar

1. **Eşik:**
   - `fund_job`, `travel_rule_threshold > 0` ve `amount >= travel_rule_threshold` ise bağlı bir commitment
     ister; yoksa `TravelRuleCommitmentRequired`.
   - Eşik settlement mint'inin taban birimindedir ve admin'in `update_params`'ıyla değişir.
   - Eşiğin değeri hukuki bir karardır; kodda değil, kurulumda verilir.
2. **Commitment:**
   - `sha256("square/travel-rule/v1" ‖ job ‖ salt ‖ sha256(kayıt))`.
   - `job` işin 32 baytlık adresidir, `salt` kurumun her iş için ürettiği 32 rastgele bayttır.
   - `kayıt`, Travel Rule kaydının RFC 8785 kanonik JSON'udur. Kaydın şeması BE-23'ündür.
3. **Ne zaman:**
   - `commit_travel_rule` yalnızca `Open` işte çalışır (`InvalidStatus`), imzacı job'un kurumudur
     (`Unauthorized`).
   - `fund_job`'a kadar yeniden çağrılabilir; son bağlanan geçerlidir. Fonlamadan sonra commitment
     değişmez.
   - Commitment eşiğin altındaki işe de bağlanabilir.
   - Sıfır commitment "yok" demektir ve bağlanamaz (`TravelRuleCommitmentRequired`).
4. **Zincirdekiler:**
   - Yalnızca 32 baytlık commitment: `Job.travel_rule_commitment` ve `TravelRuleCommitted { job, commitment }`.
   - Kayıt ve salt zincir dışında, şifreli saklanır (BE-23).
5. **Doğrulama:** Kaydı ve salt'ı gören taraf (karşı VASP, denetçi) commitment'ı yeniden hesaplar ve
   job'daki değerle karşılaştırır.
   - Hesaplama SDK'da `travelRule.commitment`, Rust'ta `square_common::travel_rule::commitment`.
   - İki uygulamanın aynılığı ortak vektörlerle denetlenir: `crates/square-common/tests/fixtures/travel-rule-vectors.json`,
     `packages/sdk/scripts/travel-rule-vectors.mjs --check`.

## Gerekçe

Bu bölümdeki gerekçeler bu ADR'ındır; kaynaklarda gerekçe yoktur.

- **Salt ve job adresi:**
  - Travel Rule kaydının alanları (ad, hesap, tutar) tahmin edilebilir. Salt'sız bir özet, adayları
    deneyerek çözülebilirdi; 32 baytlık rastgele salt bunu engeller.
  - Job adresi commitment'ı tek bir işe bağlar: aynı kayıt ve salt başka bir işte geçerli bir commitment
    vermez.
- **Kayıt yerine kaydın özeti:** Commitment kaydın kanonik özeti üzerinden kurulur. Zincirdeki doğrulayıcı
  JSON işlemez; kaydın biçimi (BE-23) değişse de commitment'ın kuralı aynı kalır. Alan ayırıcıdaki sürüm,
  kuralın değişmesi gerekirse eskisini ayırır.
- **Yalnızca `Open` işte:**
  - Fonlama, para hareketinin kaydın bağlandığı andır. Commitment sonradan değişebilseydi fonlanan iş
    başka bir kayda bağlanabilirdi.
  - Fonlamadan önceki düzeltme bir zarar doğurmaz: escrow'da henüz para yoktur.
- **Eşitlikte de gerekmesi:** Sözleşmenin dokümanı `amount >= threshold` der; eşik, bilginin gerektiği en
  küçük tutar olarak yorumlanır.
- **Eşiğin altı:** Kurum gönüllü olarak commitment bağlayabilir; eşik yalnızca zorunluluğun sınırıdır.

## Sonuçlar

- **Uygulama:** `programs/square-escrow/src/instructions/commit_travel_rule.rs`; `fund_job`'daki kural
  `square_common::travel_rule::required`'tır.
- **Testler:** `tests/programs/tests/travel_rule.rs`:
  - bağlama ve fonlamaya kadar düzeltme, fonlamadan sonra değişmeme;
  - eşik eşitliği, eşiğin altı ve kapalı eşik;
  - başka kurum ve sıfır commitment;
  - zincirde kişisel veri olmaması ve commitment'ın doğrulanması.
- **Sözleşme:** Program sözleşmesi v0.4.2. Travel Rule yüzeyinin dokümanları taslak işaretinden çıktı;
  alanlar, talimat ve kodlar değişmedi.
- **SDK** (API sözleşmesi v0.11.0): `travelRule` (kayıt özeti, commitment, salt), `flow.commitTravelRule`.
  İşlem profilinde `commitTravelRule` var.
- **Açık:** BC-34'ün "Squads üzerinden devnet upgrade'i" kalemi devnet deploy'uyla yapılır (BC-09,
  BC-30).

## Açık noktalar

- Travel Rule kaydının şeması, şifrelenmesi ve saklanması, karşı tarafa iletilmesi: BE-23.
- Eşiğin ağ bazındaki değeri: hukuki karar, deploy'da verilir.
