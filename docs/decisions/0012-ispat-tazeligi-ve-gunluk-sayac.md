# ADR 0012: Release ispatının tazeliği ve günlük sayacın ilerlemesi

- **Durum:** Kabul edildi
- **Issue:** BC-21 (#29)
- **Karar kaynağı:** BC-21 iş kalemi 4 ("ispat tazeliği kuralı; günlük sayacın release'te ilerlemesi için
  ADR"), 2026-10-05
- **Kapsam:** `programs/square-verifier` (`set_compliance_proof`, `record_release`),
  `crates/square-common` (`release`), escrow'un release talimatları (BC-23, BC-24), kurumun ispat
  yazılımı (`@squaresdk/solana-policy`, BE-10)

## Bağlam

- Release ispatı, release'in zincirde yapılacağı hâline bağlıdır: payee, net tutar, mint, kurumun o UTC
  günündeki harcama sayacı ve ispatın değerlendirildiği an ([release-circuit.md](../design/release-circuit.md)
  §2). Verifier bu sinyallerin 10'unu hesaplardan kendisi kurar (§6, yol A).
- Sayaç (`OperatorState.daily_spent`) verifier'ındır; escrow onu yazamaz. Sözleşme sayacın escrow →
  verifier `record_release` CPI'ıyla ilerlediğini varsayar ve bunu bu issue'nun ADR'ına bırakır
  ([program arayüzü](../design/program-interface.md) §4 "Tek CPI", §8 açık nokta 4).
- Sözleşmede kontroller paylaşılmıştır: verifier ispatı job'un policy anlık görüntüsüne karşı doğrular ve
  payee ile mint'i bağlar; escrow release'te payee, net tutar, mint ve sayacı yeniden karşılaştırır, biri
  farklıysa `StaleReleaseProof` döner (§4 "Kontrollerin paylaşımı").
- Devre belgesi iki kural koyar: sayaç ispat anının UTC gününe göre okunur, gün değiştiyse etkin sayaç
  0'dır; ispatın anı zincirin saatine "küçük bir tolerans" içinde olmalıdır (§6).
- Arc (`wienerlabs/square`, `docs/decisions/proof-freshness.md`) aynı sorunu EVM'de çözdü: sayaç sinyali
  eşitlikle bağlanır ("loosening it to an inequality would let a proof made under a low counter pay out
  under a high one"), ispatın anı release bloğuna bir tolerans içinde olmalıdır (orada bir saat) ve
  ispatı release'e yakın bağlamak kurumun yazılımının görevidir; keeper ispattan habersizdir.

## Değerlendirilen seçenekler

1. **Sayacın ne zaman ilerlediği.** (a) Bağlamada: bağlanan her ispat sayacı ilerletir. Reddedilen,
   iptal edilen ya da yeniden bağlanan ispatlar ödenmemiş tutarları da sayar. (b) Release'te: yalnızca
   gerçekten ödenen tutar sayılır. Sözleşmenin `record_release` varsayımı budur.
2. **Sayacın bağlanması.** (a) Eşitlik: release anındaki sayaç ispattakine eşit olmalı. (b) Eşitsizlik:
   release anındaki sayaç ispattakinden büyük değilse yeter. (b), düşük sayaçla yapılmış ispatın yüksek
   sayaçla ödenmesine izin verir; tavan kuralı ispatta değerlendirildiği sayaca göredir.
3. **Saatin denetlendiği yer.** (a) Release'te ispatın anı zincirin saatine tolerans içinde olmalı. Keeper
   permissionless'tır ve release anı kurumun elinde değildir: tolerans geçince her ispat bayatlar.
   (b) Bağlamada tolerans; release'te ise ispatın günü ve o günün sayacı. Saat seçimi kurumun bağlama
   anıyla sınırlanır, release'in günü de sayacın anlamını korur.

## Karar

1. **Sayaç yalnızca release'te ilerler.** Escrow release'te verifier'ın `record_release`'ini
   `["escrow_authority"]` PDA'sıyla CPI olarak çağırır. Verifier imzacının `VerifierConfig.escrow_program`
   altındaki bu PDA olduğunu doğrular. `Compliant` ispatın `net_amount`'u sayaca eklenir. `Refused`
   ispatın release'i iadedir: sayaç ilerlemez, ispat yine tüketilir.
2. **Gün dönümü UTC gece yarısıdır.** `OperatorState.day_start_unix` bir anın gününden eskiyse o an için
   etkin sayaç 0'dır; durum o anın gününden yeniyse sayaç o an için bilinemez
   (`square_common::release::daily_spent_at`).
3. **Bağlamada (`set_compliance_proof`):**
   1. `proof_timestamp`, zincirin saatine en fazla `CLOCK_TOLERANCE_SECS` (600 s) uzak olmalı; değilse
      `StaleProof`.
   2. `daily_spent_before`, sayacın `proof_timestamp`'ın UTC gününe göre etkin değeridir. Durum daha yeni
      bir güne aitse `StaleProof`.
   3. İspat tüketilene kadar yeniden bağlanabilir; tüketilmiş ispat `ProofAlreadyConsumed`.
4. **Release'te ispat ancak şunların hepsi doğruysa tazedir** (`square_common::release::check_fresh`):
   1. payee, net tutar ve mint escrow'un release için hesapladığıyla aynı;
   2. release, ispatın değerlendirildiği UTC gününde;
   3. sayacın release anındaki etkin değeri ispattaki `daily_spent_before`'a eşit.

   Escrow bayat ispatta `StaleReleaseProof` döner ve bekler; kurum güncel ispatı bağlar. Verifier
   `record_release`'te sayacı ilerletmeden önce 2. ve 3. maddeyi yeniden uygular (`StaleProof`): sayacın
   anlamı verifier'ındır.
5. **İspatı release'e yakın bağlamak kurumun yazılımının görevidir.** Keeper ispattan habersizdir;
   bayat ispatla release reddedilir, escrow bekler.
6. Tolerans programda sabittir. `VerifierConfig` sözleşmesinde tolerans alanı yoktur; değiştirmek
   program yükseltmesi ya da sözleşme değişikliğidir.

## Gerekçe

- Release'te ilerleme (1b) ve eşitlikle bağlama (2a), sözleşmenin `record_release` ve `StaleReleaseProof`
  tanımlarına ve Arc'ın kararına dayanır: tavan kuralı ispatta hangi sayaca göre değerlendirildiyse
  ödeme o sayaçla yapılmalıdır.
- Saatin bağlamada denetlenmesi (3b), Solana'da release'i permissionless keeper'ın yapmasından gelir. Arc'ta
  release bloğunun anı denetleniyordu; burada release anı kurumun elinde değildir. Gün kuralı,
  `daily_spent_before`'ın bir güne ait olmasından gelir: dünün 0 sayacıyla yapılmış bir ispat bugünün
  kurallarını (zaman penceresi, günlük tavanlar) değerlendirmemiştir.
- 600 s, bu ADR'ın seçimidir; kaynakta Solana için bir değer yoktur. Tolerans, kurumun ispatın anını
  seçebildiği aralığı (zaman penceresi kuralı, ret biti 5) sınırlar. Değer, ispatı üretme süresini (Arc,
  `prover-trust-boundary.md`: aynı devre ailesinde 755–893 ms; bu repoda `program-proofs.mjs` yedi ispatı
  yaklaşık 17 s'de üretti) ve işlemin ağa ulaşma süresini rahatça kapsayacak kadar geniş, Arc'ın bir
  saatinden dardır.

## Sonuçlar

- Verifier: `programs/square-verifier` (`set_compliance_proof`, `record_release`, `CLOCK_TOLERANCE_SECS`);
  kural `crates/square-common/src/release.rs`. Testler `tests/programs/tests/verifier.rs`: bağlamada
  tolerans, başka bir release'ten sonra bayatlama, gün dönümü, yeniden bağlama ve tüketim.
- BC-24: escrow'un release talimatları `check_fresh`'i uygulayıp `StaleReleaseProof` döner ve
  `record_release`'i CPI ile çağırır. BC-21'in "bayat ispat release'te geçersiz sayılıyor" kriterinin
  escrow tarafı orada tamamlanır.
- `@squaresdk/solana-policy` (BE-10) sayacı aynı kuralla okur (`witness.ts`: aynı gün değilse 0).
- Aynı günün iki release'i yarışır: ilki sayacı ilerletince ikincinin ispatı bayatlar. Arc bunu keeper'ın
  release'i önceden simüle edip bayat ispatta beklemesiyle çözdü; Solana keeper'ı için karar BC-23'te.

## Açık noktalar

- Kararı verilmiş dispute'ta (`Resolved`) ispatın bağlanması: sözleşme bağlamayı `Delivered` ve
  `Disputed` işlere izin verir; Split'te agent tarafının tutarı karardan sonra bilinir (§8 açık nokta 3).
  BC-24'te kesinleşir.
- Toleransın mainnet değeri: kamusal tören (BC-38) ve audit öncesinde ölçümlerle gözden geçirilir.
