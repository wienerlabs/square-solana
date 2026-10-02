# db/

Tek Postgres veritabanının şeması ve migration'ları: **Prisma**
([§12.4](../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Kaynak projelerdeki dört
ayrı veritabanı kurulumunun (Neon + Prisma, 2× ham `pg`, Supabase) yerini alır [BE-04].

On-chain durum (job, itibar vb.) için doğruluk kaynağı zincirdir; veritabanı bunun indexer'ın
event'lerden kurduğu görünümünü [BE-14] ve zincire çıkmayan veriyi (ör. teslimatlar [BE-18],
şifreli Travel Rule verisi [BE-23]) tutar.

[BE-04]: https://github.com/wienerlabs/square-solana/issues/18
[BE-14]: https://github.com/wienerlabs/square-solana/issues/47
[BE-18]: https://github.com/wienerlabs/square-solana/issues/51
[BE-23]: https://github.com/wienerlabs/square-solana/issues/73
