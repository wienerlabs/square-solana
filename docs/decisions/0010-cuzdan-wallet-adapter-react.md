# ADR 0010: Cüzdan bağlantısı: `@solana/wallet-adapter-react`

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), Wallet
  satırı (2026-10-02)
- **Kapsam:** `apps/web` ve web'de cüzdanla imzalanan akışlar

## Bağlam

Covenant `@solana/connector` ve WalletConnect, Aperture ile AIP `wallet-adapter-react` kullanıyordu
([§7](../analysis/square-solana-analysis.md#7-%C3%B6rt%C3%BC%C5%9Fmeler-ve-%C3%A7ak%C4%B1%C5%9Fmalar),
11. satır). Analiz iki kütüphane arasında seçim sordu
([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
soru 10).

## Karar

Web uygulaması cüzdan bağlantısı için `@solana/wallet-adapter-react` kullanır.

## Gerekçe

Analizde ayrıca gerekçe yazılmadı. Soru yalnızca kütüphanenin üç kaynak projenin ikisinde kullanıldığını
belirtir (§11, soru 10).

## Sonuçlar

- Uygulama FE-01'dedir (#21).
- SDK cüzdan bağımsızdır: `@squaresdk/solana-sdk` imzalamayı wallet-adapter ile uyumlu bir arayüzle
  (`WalletLike.signTransaction`) alır.
- `@solana/kit` geçişi ve tasarım sistemi (FE-02, #22) ayrı kararlardır.
