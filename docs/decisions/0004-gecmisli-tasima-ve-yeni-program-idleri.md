# ADR 0004: Programların geçmişleriyle taşınması ve yeni Square program kimlikleri

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.1](../analysis/square-solana-analysis.md#121-mimari-ve-ta%C5%9F%C4%B1ma) (2026-10-02)
- **Kapsam:** `programs/`, `circuits/payment-compliance/`, taşınan off-chain dizinler, `docs/provenance/`,
  `NOTICE`; program kimlikleri (`declare_id!`, `Anchor.toml`, IDL `address`)

## Bağlam

Hedef mimari tek Anchor workspace'tir ([ADR 0003](0003-mimari-yol-c-tek-anchor-workspace.md)). Kaynak
programlar üç ayrı repoda duruyordu. Analiz, devnet'teki kaynak programlarda korunmaya değer state
olmadığını tespit etti: Covenant programında 0 hesap var, AIP ve Aperture programlarında yalnızca test
verisi
([§8](../analysis/square-solana-analysis.md#8-birle%C5%9Ftirme-se%C3%A7enekleri) girişi, yönetici
özeti).

## Karar

1. Taşıma `git subtree` ile geçmişli yapılır. Subtree için kaynak repolar tam geçmişle klonlanır
   (`--depth 1` değil).
2. Taşınanlar: Covenant `programs/covenant`; Aperture `programs/{policy-registry, verifier}` ve
   `circuits/payment-prover`; AIP `programs/aip-escrow/programs/aip-registry`. Off-chain kod kapsam içi
   modüller bazında taşınır ([§12.3](../analysis/square-solana-analysis.md#123-kapsam)).
3. Programlar yeni Square program kimlikleriyle deploy edilir.

## Gerekçe

- Geçmiş: yalnızca ilgili dizinlerin geçmişi alınır, gamification ve app kodu taşınmaz (§8, seçenek b
  artıları).
- Yeni kimlikler: devnet'te korunacak gerçek state olmadığı için yeni ID'lerle temiz başlangıcın
  maliyeti düşüktür (§8 "Neden" paragrafı); taşıma temiz Square marka ID'leri verir (§8, seçenek b
  artıları).
- Tam geçmişli klonlama: §12.1 bunu subtree taşımasının koşulu olarak yazar ("Subtree için kaynak
  repolar tam geçmişle klonlanır"). Analizin okumaları `--depth 1` klonlarla yapılmıştı (analiz
  başlığı); §12.1'in notuna göre Covenant'ın tam geçmişi analiz sırasında ayrıca çekildi, katkıcıları
  §12.5'te. Başka gerekçe yazılmadı.

## Sonuçlar

- Taşıma kaydı [lisans politikasındaki](../licensing.md#ta%C5%9F%C4%B1nan-kod) gibi tutulur: kaynağın
  `LICENSE` dosyası taşınan dizinde kalır, kaynak repo, commit ve yöntem `docs/provenance/<issue>.md`'ye,
  taşınan yol `NOTICE`'e yazılır.
- Eski npm paketleri ve canlı siteler eski ID'lere bağlı kalır; devnet test verisi yeni ID'lere
  taşınmaz ve bu bilinçli bir kabuldür
  ([§10](../analysis/square-solana-analysis.md#10-riskler) R10, R11).
- Durum (2026-10-03): BC-05 (#5), BC-06 (#6), BC-07 (#7) ve BE-02 (#16) taşımaları tamamlandı. Covenant
  escrow'unun taşınması (BC-04, #4) Covenant LGPL kodunun yeniden lisanslama onaylarını (BC-03, #3)
  bekliyor ([ADR 0005](0005-lisans-apache-2-0-ve-notice.md)).
- Yeni program kimlikleri henüz atanmadı: `Anchor.toml`, `declare_id!` ve IDL'lerin `address` alanı
  kaynak programların kimliklerini taşıyor. Atama BC-09'dadır (#9,
  [ADR 0008](0008-upgrade-authority-2-of-3-squads.md)). IDL'deki adres kullanılmaz: SDK program
  kimliklerini yapılandırmadan (`programIds`), veritabanı seed'i ortamdan (`SQUARE_PROGRAM_ID_*`) alır.

### Uygulama notları

- **Yöntem:** BC-05'teki provada `git subtree`, Aperture'ın tüm repo geçmişinden commit sızdırdı. Bu
  yüzden taşımalar `git filter-repo` ile yapıldı
  ([BC-05 provenance, Yöntem](../provenance/BC-05.md#y%C3%B6ntem)); BC-06, BC-07 ve BE-02 aynı yöntemi
  kullandı. Kararın özü değişmedi: geçmiş korunur, yalnızca ilgili yollar alınır. README ve
  `programs/README.md` iki yöntemi birlikte anar.
- **AIP kaynağı:** analiz `wienerlabs/aip-beta`'yı okudu. Taşıma, `wienerlabs/aip-beta`'nın eski bir
  kopya olduğu tespit edildiği için `dr-wilson-empty/aip-beta`'dan yapıldı
  ([BC-07 provenance](../provenance/BC-07.md), karar #7'de).

## Açık noktalar

- Eski artefaktların (npm paketleri, canlı siteler) kullanımdan kaldırılması §12'de karara bağlanmadı
  ([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
  soru 13).
