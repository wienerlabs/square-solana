# db/

Tek Postgres veritabanının şeması ve migration'ları: **Prisma**
([§12.4](../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)). Kaynak projelerdeki dört
ayrı veritabanı kurulumunun (Neon + Prisma, 2× ham `pg`, Supabase) yerini alır [BE-04].
Paket adı `@squaresdk/solana-db` (private); tasarım ve kararlar:
[`docs/design/data-model.md`](../docs/design/data-model.md).

On-chain durum (job, itibar vb.) için doğruluk kaynağı zincirdir. Veritabanı, indexer'ın
event'lerden kurduğu görünümü [BE-14] ve zincire çıkmayan veriyi (ör. teslimatlar [BE-18], şifreli
Travel Rule verisi [BE-23]) tutar.

| Yol | İçerik |
|---|---|
| `prisma/schema.prisma` | Şema |
| `prisma/migrations/` | Migration'lar (`prisma migrate deploy` ile uygulanır) |
| `prisma.config.ts` | Prisma CLI yapılandırması; bağlantı adresi `DATABASE_URL`'den |
| `src/index.ts` | `createDatabaseClient({ connectionString })`, model ve enum tipleri |
| `src/seed.ts`, `src/programs.ts` | Seed: program kimlikleri `SQUARE_PROGRAM_ID_*`'dan, IDL sürümleri IDL'den |
| `src/testing.ts` | `@squaresdk/solana-db/testing`: testler için izole Postgres (Testcontainers) |
| `scripts/check-constraints.mjs` | Sütun tipinden türeyen CHECK kısıtları |

```bash
pnpm turbo build --filter @squaresdk/solana-db          # prisma generate + tsc
DATABASE_URL=<postgres-url> pnpm --filter @squaresdk/solana-db migrate:deploy
DATABASE_URL=<postgres-url> SQUARE_PROGRAM_ID_REGISTRY=<id> SQUARE_PROGRAM_ID_POLICY=<id> \
  SQUARE_PROGRAM_ID_VERIFIER=<id> SQUARE_PROGRAM_ID_ESCROW=<id> \
  pnpm --filter @squaresdk/solana-db seed
pnpm turbo test --filter @squaresdk/solana-db           # Docker gerekir
```

[BE-04]: https://github.com/wienerlabs/square-solana/issues/18
[BE-14]: https://github.com/wienerlabs/square-solana/issues/47
[BE-18]: https://github.com/wienerlabs/square-solana/issues/51
[BE-23]: https://github.com/wienerlabs/square-solana/issues/73
