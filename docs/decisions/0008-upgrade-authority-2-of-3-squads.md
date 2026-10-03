# ADR 0008: Program upgrade authority: 2-of-3 Squads multisig

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), Upgrade
  authority satırı (2026-10-02)
- **Kapsam:** dört Square programının upgrade authority'si; `init_*` ve `update_*` config
  instruction'larının admin doğrulaması

## Bağlam

Kaynak programlar ayrı repolarda, ayrı upgrade authority'lerle duruyordu
([§8](../analysis/square-solana-analysis.md#8-birle%C5%9Ftirme-se%C3%A7enekleri), seçenek a
eksileri); Covenant programının upgrade authority'si bir deployer anahtarıydı
([§1.2](../analysis/square-solana-analysis.md#12-on-chain)). Analiz, upgrade authority'nin Squads
multisig olup olmayacağını ve üyelerini sordu
([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
soru 7).

## Karar

1. Square programlarının upgrade authority'si 2-of-3 Squads multisig'dir.
2. Üyeler: MuhammedAkinci, mehmethayirli, kh0ra.

## Gerekçe

Analiz, taşımayla upgrade authority'nin tek elde (Squads) toplanmasını seçenek b'nin artısı olarak
kaydetti (§8). Eşik (2) ve üye seçimi için ayrıca gerekçe yazılmadı; üç kişilik ekip §8'in ortak
varsayımıdır.

## Sonuçlar

- Program sözleşmesi bu modele göre yazıldı: `admin` rolü programın upgrade authority'sidir (Squads
  vault'u) ve `init_*` instruction'ları bunu `program_data` ile doğrular
  ([program arayüzü §2](../design/program-interface.md#2-roller)).
- Durum (2026-10-03): uygulanmadı. Yeni program kimlikleri, devnet'te Squads v4 multisig'i,
  `docs/runbooks/upgrade.md` ve deploy anahtarlarının secret store'da tutulması BC-09'dadır (#9).
- Mainnet'te authority devri dış audit'ten sonradır (M9; BC-42, #98).

## Açık noktalar

- Vanity program kimlikleri §12'de karara bağlanmadı (§11, soru 7).
- Üyelerin multisig'deki anahtar adresleri henüz kayıtlı değil (BC-09, #9).
