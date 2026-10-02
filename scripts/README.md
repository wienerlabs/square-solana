# scripts/

Repo düzeyindeki operasyon script'leri: deploy, init, Address Lookup Table kurulumu ve devnet
smoke ([§9](../docs/analysis/square-solana-analysis.md#9-%C3%B6nerilen-monorepo-yap%C4%B1s%C4%B1)).

| Konu | Issue |
|---|---|
| [`license/`](license/): lisans envanteri ve CI kapısı (`pnpm license:check`, `pnpm license:write`) | [BC-02] |
| Address Lookup Table, compute budget, priority fee | [BC-28] |
| Devnet deploy + init (escrow config, screener authority, ALT) | [BC-30] |
| Devnet uçtan uca smoke: 8 adım gerçek işlemlerle, tx / CU / ücret raporu | [BC-31] |

Anahtarlar ve secret'lar repoya girmez (`.gitignore`: `*keypair*.json`, `.env*`); deploy
keypair'leri secret store'da tutulur [BC-09].

[BC-02]: https://github.com/wienerlabs/square-solana/issues/2
[BC-09]: https://github.com/wienerlabs/square-solana/issues/9
[BC-28]: https://github.com/wienerlabs/square-solana/issues/36
[BC-30]: https://github.com/wienerlabs/square-solana/issues/38
[BC-31]: https://github.com/wienerlabs/square-solana/issues/43
