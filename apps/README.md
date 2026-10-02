# apps/

Uygulama ve servisler (pnpm workspace). `package.json` adları `@squaresdk/solana-<ad>` biçiminde ve
`private: true` [BE-01]. Hosting: web **Vercel**, API ve worker'lar **Railway**
([§12.4](../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar), [BE-05]).

| Dizin | Görev | Issue |
|---|---|---|
| `web/` | Next.js web uygulaması (`@solana/wallet-adapter-react`), 8 adımlı akış ve demo | [FE-01] |
| `api/` | REST API: auth, okuma uçları, tx hazırlama, teslimat yükleme | [BE-18] |
| `indexer/` | Anchor event'lerinden Postgres'e indexer | [BE-14] |
| `keeper/` | finalize crank (kârlılık, `ProofRequired` ve screening farkındalığı) | [BE-15] |
| `prover/` | Groth16 prover servisi (snarkjs) | [BE-11] |
| `screener/` | sanctions screening servisi | [BE-16] |

Tüm servisler tek veritabanını ([`db/`](../db/)) kullanır.

[BE-01]: https://github.com/wienerlabs/square-solana/issues/15
[BE-05]: https://github.com/wienerlabs/square-solana/issues/19
[BE-11]: https://github.com/wienerlabs/square-solana/issues/44
[BE-14]: https://github.com/wienerlabs/square-solana/issues/47
[BE-15]: https://github.com/wienerlabs/square-solana/issues/48
[BE-16]: https://github.com/wienerlabs/square-solana/issues/49
[BE-18]: https://github.com/wienerlabs/square-solana/issues/51
[FE-01]: https://github.com/wienerlabs/square-solana/issues/21
