# ADR 0009: Veritabanı: tek Postgres ve Prisma

- **Durum:** Kabul edildi
- **Issue:** BE-06 (#20)
- **Karar kaynağı:** analiz [§12.4](../analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), DB
  satırı (2026-10-02)
- **Kapsam:** [`db/`](../../db/) (`@squaresdk/solana-db`) ve veritabanı kullanan tüm servisler

## Bağlam

Kaynaklarda dört ayrı veritabanı kurulumu vardı: Covenant'ta Neon ve Prisma (30 model), Aperture'da iki
ayrı Postgres ve ham `pg`, AIP'de Supabase
([§7](../analysis/square-solana-analysis.md#7-%C3%B6rt%C3%BC%C5%9Fmeler-ve-%C3%A7ak%C4%B1%C5%9Fmalar),
13. satır). Analiz sağlayıcıyı (Neon, Supabase, Railway) ve ORM'i sordu, ORM için Prisma'yı önerdi
([§11](../analysis/square-solana-analysis.md#11-a%C3%A7%C4%B1k-sorular-faz-2ye-ge%C3%A7meden-%C3%B6nce-cevap-gerekiyor--12de-cevapland%C4%B1),
soru 9).

## Karar

1. Tüm servisler tek bir Postgres veritabanını kullanır.
2. Şema ve migration'lar Prisma ile yönetilir.

## Gerekçe

Tek Postgres ve tek migration sistemi analizin önerisidir (§7, 13. satır). Prisma tercihinin gerekçesi
analizde yazılmadı; §11'de öneri olarak geçer.

## Sonuçlar

- Uygulandı (BE-04, #18): `db/` paketi, Prisma şeması ve migration'lar. Tasarım ve ilkeler
  [veri modelindedir](../design/data-model.md): zincir kaynak-gerçektir, ayna tablolara yalnızca
  indexer yazar, gizli veri düz metin tutulmaz.
- compliance-api, BE-25'e (#80) kadar kendi ham `pg` migration'larıyla çalışır
  ([veri modeli §7](../design/data-model.md#7-kaynaklardan-farklar)).
- §12.4 Postgres sağlayıcısını ayrıca yazmadı; BE-05 (#19) Postgres'i Railway projesine koyar
  ([ADR 0002](0002-web-hosting-railway.md)). Testlerdeki Postgres imajı üretimdeki ana sürümle
  aynı tutulur ([veri modeli, Açık noktalar](../design/data-model.md#9-a%C3%A7%C4%B1k-noktalar)).
