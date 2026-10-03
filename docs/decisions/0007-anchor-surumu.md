# ADR 0007: Anchor sürümü: en güncel kararlı sürüm, M1'de sabitlenir

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), Anchor
  satırı (2026-10-02)
- **Kapsam:** `programs/*`, `Anchor.toml`, `rust-toolchain.toml`, `@coral-xyz/anchor` kullanan TS
  paketleri

## Bağlam

Kaynaklar farklı Anchor sürümleri kullanıyordu: Rust tarafında Covenant 0.30.1 (pin'li, cargo 1.84
yamasıyla), Aperture 0.31.1, AIP 0.30.1; TS tarafında Covenant SDK 0.30.1, Covenant app'i ve AIP
programları 0.32.1
([§7](../analysis/square-solana-analysis.md#7-%C3%B6rt%C3%BC%C5%9Fmeler-ve-%C3%A7ak%C4%B1%C5%9Fmalar),
6. ve 7. satırlar). Analiz iki seçenek sordu: en az 0.31.1 ya da M1 sırasında en güncel kararlı sürüm
([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
soru 6).

## Karar

1. Anchor'ın en güncel kararlı sürümü kullanılır.
2. Sürüm M1'de sabitlenir.

## Gerekçe

Analiz tek workspace için tek sürümü şart sayar (§7, 6. satır); sürüm göçü M1'in ilk işi olarak ele
alınır ve CI'da sabitlenir ([§10](../analysis/square-solana-analysis.md#10-riskler) R7). §11'deki soru,
Covenant app'i ile AIP'nin TS tarafının zaten 0.32.1 kullandığını not eder (soru 6). "En güncel kararlı
sürüm" tercihi için başka gerekçe yazılmadı.

## Sonuçlar

- Durum (2026-10-03): sürüm henüz sabitlenmedi. Taşınan üç programın `Cargo.toml`'u `anchor-lang`
  0.31.1 ister (`Cargo.lock` 0.31.2'ye çözer), TS paketleri `@coral-xyz/anchor` 0.31.1'e sabit;
  README'deki geliştirme ortamı tablosu Anchor CLI'ı "BC-08 ile sabitlenecek" olarak gösteriyor.
- Sabitleme BC-08'dedir (#8): hedef sürüm, `Anchor.toml` `[toolchain]` ve `rust-toolchain.toml`,
  gerekmiyorsa Covenant'ın `constant_time_eq` yamasının kaldırılması, escrow'da `token_interface`,
  dört programın IDL üretimi. BC-08, escrow'un kendi sürümüyle taşınmasından (BC-04, #4) sonra gelir.
  Kabul kriterlerinden biri Rust ve TS istemcisi için tek Anchor sürümünün belgelenmesidir; sabitlenen
  sürüm bu ADR'nin sonuçlarına eklenir.
- SBF derlemesi platform-tools rustc 1.84 ile yapılır (`.cargo/config.toml`); seçilecek sürüm bu
  kısıtla uyumlu olmalıdır.

## Açık noktalar

- Aynı token hesabının bir instruction'da iki kez yazılabilir olarak geçmesinin seçilen sürümde kabul
  edildiği doğrulanmalıdır ([program arayüzü, Açık noktalar](../design/program-interface.md#a%C3%A7%C4%B1k-noktalar),
  8. madde).
