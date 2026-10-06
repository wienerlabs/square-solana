# ADR 0024: Stripe MPP fiat rayı: fiat iş, ödeme kanıtının job'a bağlanması ve MPP authority'nin config'te olması

- **Durum:** Kabul edildi
- **Issue:** BC-37 (#78)
- **Karar kaynağı:**
  - BC-37 iş kalemleri 1–3 ve kabul kriterleri ("MPP ispatı localnet'te doğrulanıyor", "Authority rotasyonu
    program upgrade gerektirmiyor");
  - [analiz](../analysis/square-solana-analysis.md) R5 (`MPP_AUTHORITY_PUBKEY` derleme zamanında sabit);
  - program arayüzü §7 "Stripe MPP" taslağı;
  - ürün kararı (2026-10-07, issue sahibi): fiat ödeme Square'in job akışını kapatır. Kurum işi fiat modunda
    USDC vault'u olmadan açar, agent teslim eder, kurum Stripe ile öder. MPP ispatı (Stripe makbuzu ve
    politika uyumu) job'a bağlanır ve iş `Released` olur. İtibar, `ValidationRecord` ve günlük sayaç USDC
    yolundaki gibi yazılır.
- **Kapsam:**
  - `programs/square-escrow`: `Job.rail`, `create_fiat_job`, `cancel_fiat_job`, `finalize_fiat_payment`;
  - `programs/square-verifier`: `verify_mpp_payment_proof`, `update_mpp_authority`;
  - `crates/square-common` (`mpp`), `@squaresdk/solana-sdk` (`mpp`, flow), `@squaresdk/solana-policy`;
  - `apps/fee-payer` (izin listesi), `apps/keeper` ve `apps/indexer` (`jobs.rail`), `tests/smoke`.

## Bağlam

- **Aperture'ın B-flow'u** (`verify_mpp_payment_proof`, BC-05 ile taşındı, BC-21 ile kaldırıldı):
  - compliance-api doğrulanmış Stripe webhook'undan makbuzun Poseidon commitment'ını üretir ve ed25519 ile
    imzalar;
  - verifier imzayı aynı tx'teki Ed25519 precompile talimatından Sysvar Instructions ile okur;
  - imzalayan anahtar derleme zamanı sabitidir (R5): rotasyon program upgrade'i ister;
  - imzalanan mesaj yalnızca 32 baytlık commitment'tır; ödemeyi bir işe ya da tutara bağlamaz.
- **Release devresi** ([release-circuit.md](../design/release-circuit.md) §2): 13 public sinyalin 12.'si
  `stripe_receipt_hash`'tir. Escrow release yolunda 0'dır, MPP yolunda argümandır.
- **Square'in job modeli:** Ödeme escrow vault'undan yapılır. Kurum fonlar, finalize payee'ye öder,
  `record_release` günlük sayacı ilerletir. Fiat ödemenin zincirde vault'u ve aktarımı yoktur.
- **Sözleşmedeki taslak** (§7):
  - `verify_mpp_payment_proof(proof, public_inputs: [[u8; 32]; 10])`;
  - `update_mpp_authority`, `VerifierConfig.mpp_authority`;
  - `MppPaymentVerified { institution, policy, stripe_receipt_hash, amount }`.

  Taslak 10 sinyali argüman olarak taşır; Ed25519 talimatıyla birlikte tx paket sınırını aşar (açık nokta 9).

## Karar

1. **Ray:**
   - `Job.rail: SettlementRail { Escrow, Fiat }`.
   - Alan hesabın sonuna eklenir. Alan gelmeden açılmış hesaplar dolgu baytlarını `Escrow` okur.
   - Fiat iş `create_fiat_job(spec_hash, amount, deadline)` ile açılır:
     - vault ve fonlama adımı yoktur;
     - iş her zaman bir politikaya bağlıdır ve onun anlık görüntüsünü alır;
     - kurumun ve agent cüzdanının screening kaydı (temiz ve taze) iş açılırken okunur. Bu, `fund_job`'ın
       kuralıdır;
     - `challenge_period` 0'dır;
     - event'i `FiatJobCreated`'tır.
2. **Yaşam döngüsü:**
   - `Open -(accept_job)-> Accepted -(submit_work)-> Delivered`.
   - Verifier'ın `verify_mpp_payment_proof`'u ödemeyi bağlar, ardından `finalize_fiat_payment` işi
     `Released` yapar.
   - `cancel_fiat_job`: `Open` iş ya da deadline'ı geçmiş `Accepted` iş `Cancelled` olur; iade yoktur.
   - Fiat işte `fund_job`, dispute (`raise_dispute`, `escalate_missing_proof`), alacak (`list_claim`) ve
     Travel Rule (`commit_travel_rule`) yoktur: `RailMismatch` (escrow 6049).
   - Escrow işinde `create_fiat_job` dışındaki fiat talimatları da `RailMismatch` alır. Verifier'da
     `set_compliance_proof` fiat işi, `verify_mpp_payment_proof` escrow işini reddeder (verifier 6011).
3. **Attestation:**
   - Mesaj: `"square/mpp-attestation/v1" ‖ job (32) ‖ stripe_receipt_hash (32) ‖ amount (u64 LE)`, 97 bayt.
     `amount` işin tutarıdır; verifier mesajı job'daki tutarla kurar.
   - İmzalayan `VerifierConfig.mpp_authority`'dir.
   - İmza, `verify_mpp_payment_proof`'tan hemen önceki talimat olan Ed25519 precompile talimatındadır:
     - tek imza taşır;
     - anahtar, imza ve mesaj talimatın kendi verisindedir (üç `instruction_index` de `u16::MAX`).

     Uymayan, eksik ya da başka anahtarla imzalanmış attestation `InvalidMppAttestation`'dır (6010).
   - Sıfır makbuz commitment'ı escrow release yolunun değeridir; MPP yolunda reddedilir.
4. **İspat:**
   - Aynı release devresi ve yol A ([release-circuit.md](../design/release-circuit.md) §6).
   - Verifier 13 sinyalin 12'sini hesaplardan ve argümandan kurar:
     - `refusal_code` 0;
     - `net_amount` işin tutarının tamamı;
     - payee `Job.agent_wallet`;
     - sinyal 12 attestation'daki makbuz commitment'ı.

     Kurumun beyanı yalnızca `proof_timestamp`'tir.
   - Yalnızca uyumlu ispat bağlanır ve `ReleaseProof` `Compliant` yazılır.
   - Talimat `ComplianceProofSet` ve `MppPaymentVerified { job, institution, policy, stripe_receipt_hash,
     amount }` yayımlar.
5. **Kapanış:**
   - `finalize_fiat_payment` permissionless'tır; challenge penceresini beklemez.
   - `ReleaseProof`'u escrow release'iyle aynı tazelik kuralından geçirir (payee, net, mint, gün, sayaç).
   - `record_release` CPI'ı ispatı tüketir ve günlük sayacı tutar kadar ilerletir.
   - İtibar (`jobs_completed`, `total_earned`) ve `Verified` bir `ValidationRecord` yazılır; iş `Released`
     olur.
   - Token hareketi ve keeper ücreti yoktur. İki PDA'nın rent'ini çağıran öder.
   - Keeper'ın `finalize_payment` crank'i fiat işi seçmez (`jobs.rail`).
6. **Rotasyon:**
   - `update_mpp_authority(mpp_authority)`'yi yalnızca config admin'i çağırabilir. Devnet'te admin Squads
     vault'udur; rotasyon bir vault tx'idir.
   - Program upgrade'i gerekmez.
   - Sıfır anahtar fiat rayını kapatır: hiçbir attestation doğrulanmaz.
7. **Birim ve tekillik:**
   - `amount` settlement mint'inin taban birimindedir (USDC, 6 ondalık).
   - Stripe tutarının bu birime çevrilmesi BE-25'indir. Bu ADR'nin varsayımı USD'dir; 1 sent 10 000 birimdir.
   - Attestation işe bağlıdır; bir imza başka bir işte kullanılamaz.
   - Bir makbuzun yalnızca bir işe attest edilmesi MPP authority'nin kuralıdır (BE-25, `mpp_payments`).
8. **Squads kurumu:**
   - `verify_mpp_payment_proof` bir vault tx'inin içinde çalışabilir.
   - Precompile CPI ile çağrılamaz. Attestation talimatı bu yüzden `vault_transaction_execute`'tan hemen önce,
     üst düzeyde gelir; Instructions sysvar'ı üst düzey talimatı sayar.
9. **Fee payer** (ADR 0019 izin listesi): Ekler:
   - `escrow:create_fiat_job`, `escrow:cancel_fiat_job`, `escrow:finalize_fiat_payment`;
   - `ed25519:verify`: yalnızca tek imzalı talimat. İmza sayısı tx ücretini artırır.

## Gerekçe

Bu bölümdeki gerekçeler bu ADR'ındır; ürün kararı gerekçe vermez.

- **Madde 1, ray alanı:** Sona eklenen alan devnet'te açılmış işleri bozmaz. Alanın sabit önekte olmaması
  `memcmp` filtresine engeldir. Keeper ve API ray filtresini aynadan yapar (`jobs.rail`).
- **Madde 1, vault yok:** Vault'un fonlanmadığı bir işte boş vault rent bağlar. Vault'a dışarıdan gönderilen
  token da kapanışı engellerdi. Vault'suz iş bu sorunları taşımaz; iptali ayrı bir talimattır.
- **Madde 2, dispute ve alacak yok:** Escrow'da tutulan bir ödeme yoktur. Dispute kararı bir şey ödeyemez,
  alacak alıcısına escrow'dan ödeme yapılamaz.
- **Madde 3, mesaj:** Aperture'ın mesajı yalnızca commitment'tır. Aynı imza başka bir işe ya da tutara
  bağlanabilirdi. Job ve tutar mesajdadır; alan ayırıcı mesajı başka imza kullanımlarından ayırır.
- **Madde 3, yönlendirme:** Ofsetlerin başka bir talimatı göstermesi, imzalanmamış baytların mesaj gibi
  okunmasına yol açar.
- **Madde 4, yalnızca uyumlu:** Ödeme zincir dışında yapılmıştır. Ret ispatı bir şeyi iade edemez.
  Kurumun politikası ödemeden önce denetlenmelidir (BE-25); kural devrede aynıdır.
- **Madde 5, challenge yok:** Kurumun Stripe ödemesi teslimi kabulüdür. Bekleyen bir escrow yoktur.
- **Madde 6:** R5'i kapatır ve kabul kriterinin ikincisidir.

## Sonuçlar

- **Uygulama:**
  - Escrow: `programs/square-escrow/src/instructions/{create_fiat_job, cancel_fiat_job, finalize_fiat_payment}.rs`;
    `state.rs` (`SettlementRail`); ortak iş kurucusu `create_job.rs` (`new_job`); kapanış kaydı
    `settlement.rs` (`record_outcome`).
  - Verifier: `programs/square-verifier/src/instructions/{verify_mpp_payment_proof, update_mpp_authority}.rs`;
    ortak bağlama kuralları `binding.rs`.
  - Mesaj ve precompile talimatının çözümü: `crates/square-common/src/mpp.rs`. SDK karşılığı
    `packages/sdk/src/mpp.ts`. Ortak vektörler: `crates/square-common/tests/fixtures/mpp-attestation-vectors.json`.
  - SDK ve kurum tarafı:
    - flow: `createFiatJob`, `cancelFiatJob`, `finalizeFiatPayment`;
    - policy: fiat witness'ı ve `buildVerifyMppPaymentProofTx`.
  - Veritabanı: `jobs.rail` (migration `20261007010000_job_rail`). Indexer onu aynalar, keeper filtreler.
- **Sözleşme v0.7.0** (program arayüzü §11):
  - talimatlar, `SettlementRail`, `FiatJobCreated`;
  - `RailMismatch` (escrow 6049, verifier 6011);
  - `MppPaymentVerified.job`.
- **Testler:**
  - `tests/programs/tests/mpp.rs` (LiteSVM, gerçek Groth16 ispatı `mpp_fiat` ve Ed25519 precompile);
  - `tx_budget.rs`: fiat tx'leri;
  - SDK, policy, fee payer, keeper ve indexer testleri;
  - localnet smoke'un `fiat` varyantı ([smoke-localnet.md](../deploy/smoke-localnet.md)).
- **Eski hesaplar:** `delivery_uri`'si tam 128 bayt olan bir job'un dolgusu yoktur. Bu job yeni düzenle
  okunamaz ve yazılamaz. Devnet'te alan eklenmeden önce açılmış işler etkilenir.

## Açık noktalar

- Stripe webhook'u, makbuzun Poseidon commitment'ı, tutarın settlement birimine çevrilmesi ve
  `mpp_payments` kaydı BE-25'tedir. Smoke Stripe ödemesi yapmaz.
- Ödenmeyen fiat iş `Delivered`'da kalır. Escrow olmadığından agent'ın zincir üstü bir başvurusu yoktur.
- Fiat işte bayatlayan ispat (aynı gün kurumun başka bir release'i sayacı değiştirirse) aynı attestation
  ve yeni bir ispatla yeniden bağlanır. `watchJobProof` fiat işi izlemez; otomatik yenileme BE-25'in
  servisindedir.
