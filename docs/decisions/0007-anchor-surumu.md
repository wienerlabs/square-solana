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

- Sabitlenen sürüm (BC-08, #8, 2026-10-04): **Anchor 1.2.0**.
  - Rust: dört programda `anchor-lang` 1.2.0 (escrow'da `anchor-spl` 1.2.0).
  - TS: `@anchor-lang/core` 1.2.0. Anchor 1.0 ile TS paketi `@coral-xyz/anchor`'dan bu ada taşındı.
  - CLI: `Anchor.toml [toolchain]` → `anchor_version = "1.2.0"`, `solana_version = "4.1.2"` (Anchor
    1.2.0'ın önerdiği Agave sürümü).
- SBF derlemesi Agave 4.1.2'nin platform-tools v1.54'üyle, rustc 1.89 ile yapılır. Crate'ler
  `rust-version = "1.89"` bildirir (`.cargo/config.toml`); host derleyici `rust-toolchain.toml`'da 1.94.1.
- Covenant'ın `constant_time_eq` yaması workspace'e hiç girmedi; gerekmedi (BC-04).
- Escrow, `anchor_spl::token` yerine `token_interface` kullanır: transferler `transfer_checked`, bu
  yüzden transfer yapan her talimat settlement mint'ini (`job_escrow.token_mint`) hesap olarak alır.
- 1.x göçü: CPI'larda `CpiContext::new(program_id, …)`; program başına tek `#[error_code]` (policy'nin
  dört ayrı hata kümesi birleşti); `solana_program` cephesinde olmayan yollar için ayrık Solana crate'leri
  (verifier: `solana-sdk-ids`, `solana-instructions-sysvar`); `[registry]` bölümü kaldırıldı.
- Dört programın IDL'i üretiliyor. SDK'nın IDL tip üreticisi Anchor 1.2.0'ın `anchor idl type`
  çıktısıyla aynı (noktalı `path`'ler de parça parça camelCase).
- Taşınabilen eski testler: verifier'ın Rust testleri (4) ve Covenant harness'ı
  (`tests/legacy/covenant.ts`) yerel validator'da 22/22 geçiyor; 1 test kaynakta da atlanıyor (saat
  ilerletme). Harness'ı çalıştıran altyapı BC-12'dedir.

## Açık noktalar

- Aynı yazılabilir hesabın bir talimatta iki kez geçmesi Anchor 1.x'te varsayılan olarak reddedilir
  (`ConstraintDuplicateMutableAccount`, 2040); izin verilecek yerde hesaba açıkça `dup` kısıtı yazılır.
  Harness'ta doğrulandı ([program arayüzü, Açık noktalar](../design/program-interface.md#a%C3%A7%C4%B1k-noktalar),
  8. madde; uygulama BC-23).
