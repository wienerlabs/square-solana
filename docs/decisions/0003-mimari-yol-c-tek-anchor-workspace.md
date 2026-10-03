# ADR 0003: Mimari yol C: tek Anchor workspace, account-read öncelikli entegrasyon

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.1](../analysis/square-solana-analysis.md#121-mimari-ve-ta%C5%9F%C4%B1ma) (2026-10-02); seçenekler ve öneri [§8](../analysis/square-solana-analysis.md#8-birle%C5%9Ftirme-se%C3%A7enekleri)
- **Kapsam:** `programs/`, `crates/`, `Anchor.toml`, `Cargo.toml`; programlar arası erişim kuralları

## Bağlam

Square'in Solana sürümü üç projenin programlarını birleştirir: Covenant escrow'u, Aperture
policy-registry ve verifier, AIP registry. Analiz, mevcut Solana kodunda bu parçaların birbirine
bağlı olmadığını, Square'in çekirdeği olan proof-gated release'in ise hiç bulunmadığını tespit etti
([§6](../analysis/square-solana-analysis.md#6-square-%C3%B6zelli%C4%9Fi--kaynak-proje-e%C5%9Flemesi),
tablonun 11. satırı). §8'in hedef mimari diyagramında bu programlar `square_registry` (aip-registry),
`square_policy` (policy-registry), `square_verifier` (verifier) ve `square_escrow` (Covenant) adını
alır.

## Değerlendirilen seçenekler

Analiz on-chain tarafta üç seçeneği karşılaştırdı (§8). Off-chain birleştirme üçünde de yapılır.

| Seçenek | Özet | Analizdeki temel eksi |
|---|---|---|
| a | Deploy edilmiş programlar aynen kalır; Square birleşik SDK, backend ve frontend olur | Proof-gated release, alıcı uygunluğu ve kimliğe bağlı itibar zincirde zorlanamaz |
| b | Programlar geçmişleriyle monorepoya taşınır, yeni ID'lerle deploy edilir | Programlar birbirinden habersiz kalır, entegrasyon yine off-chain olur |
| c | Tek Anchor workspace; programlar birbirini CPI ya da account-read ile okur | En büyük efor ve audit yüzeyi, escrow'un yeniden tasarımı, ALT ihtiyacı |

## Karar

1. Hedef mimari yol C'dir: tek Anchor workspace; programlar zincir üzerinde birbirine bağlıdır.
2. Entegrasyonda account-read önceliklidir; CPI yalnızca gerektiğinde kullanılır.
3. Taşıma yöntemi ve program kimlikleri [ADR 0004](0004-gecmisli-tasima-ve-yeni-program-idleri.md)'tedir.

## Gerekçe

Analizin gerekçesi (§8, "Neden" paragrafı):

- (a) Square'in "compliance-gated settlement" iddiasını zincirde karşılamaz; ürün Arc sürümünün
  gerisinde kalır.
- (b) tek başına aynı açığı taşır; taşıma maliyeti ödenir ama ürün kazancı alınmaz.
- Aşamalı yaklaşımda taşıma adımı bitince ekip çalışan, tek repolu bir sisteme sahip olur; c'nin
  entegrasyonları milestone'lar halinde eklenebilir ve her biri bağımsız test edilebilir.

Seçenek c'nin artıları (§8, seçenek c "Artılar" satırı): Square ürününü zincirde gerçekleştiren tek
seçenektir. Release `(job, payee, net, mint)`'e bağlı ispatı doğrular, job registry'deki agent'a
bağlanır, alacak alıcısı policy'deki `buyer_root` ile denetlenir, itibar agent kaydına yazılır.

Account-read tercihi (§8, önerinin 2. adımı): kurum ispatı release'ten önce verifier'a bağlar, escrow
`ReleaseProof` PDA'sını owner ve seed kontrolüyle okur. Böylece keeper'ın tx'inde ispat taşınmaz,
compute ve tx boyutu sorunu crank'ten ayrışır, CPI derinliği artmaz.

## Sonuçlar

- Tek workspace: `Cargo.toml` (`programs/*`, `crates/*`) ve `Anchor.toml`. Ortak seed'ler, roller, hata
  kodları ve hesap tipleri `square-common` crate'ine (BC-10, #10), event tipleri normatif event
  şemasıyla birlikte (BC-16, #23) gider.
- Programlar arası okumaların owner ve alan kontrolleri ile tek CPI istisnası (escrow → verifier
  `record_release`) [program arayüz sözleşmesinde](../design/program-interface.md#4-programlar-aras%C4%B1-eri%C5%9Fim)
  yazılıdır.
- Analizin seçenek c için saydığı eksiler (§8; [§10](../analysis/square-solana-analysis.md#10-riskler)
  R6): en büyük efor ve audit yüzeyi, escrow'un yeniden tasarımı, ALT ihtiyacı, compute ve tx boyutu
  baskısı, CPI derinlik sınırı.
- Durum (2026-10-03): registry, policy ve verifier taşındı (BC-05 #5, BC-07 #7). Escrow'un taşınması
  (BC-04, #4) Covenant LGPL kodunun yeniden lisanslama onaylarını (BC-03, #3) bekliyor.

## Açık noktalar

- `square-common` crate'i (BC-10, #10) ve normatif event şeması (BC-16, #23).
- ALT, compute budget ve priority fee ayarı (BC-28, #36).
- Program test altyapısı ve entegrasyon testleri (BC-12 #12, BC-29 #37).
- Güvenlik incelemesi ve audit hazırlığı (BC-39, #93, M8); dış audit (BC-40 #96, BC-41 #97, M9).
