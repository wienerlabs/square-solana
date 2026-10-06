# apps/

Uygulama ve servisler (pnpm workspace). `package.json` adları `@squaresdk/solana-<ad>` biçiminde ve
`private: true` [BE-01]. Hosting: web, API ve worker'lar **Railway**
([§12.4](../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar),
[ADR 0002](../docs/decisions/0002-web-hosting-railway.md), [BE-05]); PR preview'ları Railway PR Environments.

| Dizin | Görev | Issue |
|---|---|---|
| [`web/`](web/) | Next.js web uygulaması (`@solana/wallet-adapter-react`); iskelet hazır, 8 adımlı akış ve demo M4'te | [FE-01] |
| [`api/`](api/) | REST API: cüzdan oturumu ve API anahtarları, okuma uçları, 8 adımın tx hazırlığı, teslimat yükleme, agent card barındırma, prover vekili, `GET /openapi.json` | [BE-18] |
| [`indexer/`](indexer/) | Event tabanlı indexer: kesinleşmiş tx'lerden event'ler ve ayna tablolar, Helius webhook ve RPC backfill, uzlaştırma, okuma API'si (`@squaresdk/solana-indexer/read`) | [BE-14] |
| [`keeper/`](keeper/) | Finalize crank: zincir doğrulaması, kârlılık eşiği, priority fee, `ProofRequired` ve screening için geri çekilme, `keeper_actions` günlüğü | [BE-15] |
| [`prover/`](prover/) | Release devresi için Groth16 prover servisi (snarkjs, `POST /v1/prove`); Aperture `prover-service`'ten geçmişiyle taşındı [BE-02], yeni devreye uyarlandı | [BE-11] |
| [`compliance-api/`](compliance-api/) | Aperture compliance API'si (MPP / Stripe, x402 raporu `@squaresdk/solana-x402` üzerinden [BE-24], kayıtsız ödeme izleyicisi); geçmişiyle taşındı [BE-02], uyarlama [BE-25] ve [BE-18] | [BE-25] |
| [`screener/`](screener/) | Sanctions screening: OFAC SDN listesi ve Chainalysis API ile tarama, screener authority anahtarıyla registry `record_screening` tx'i, TTL yenileme, denetim kaydı ve API ([ADR 0020](../docs/decisions/0020-sanctions-screening-kaynaklari-ve-saglayici.md)) | [BE-16] |

Tüm servisler tek veritabanını ([`db/`](../db/)) kullanır.

[BE-01]: https://github.com/wienerlabs/square-solana/issues/15
[BE-02]: https://github.com/wienerlabs/square-solana/issues/16
[BE-05]: https://github.com/wienerlabs/square-solana/issues/19
[BE-11]: https://github.com/wienerlabs/square-solana/issues/44
[BE-14]: https://github.com/wienerlabs/square-solana/issues/47
[BE-15]: https://github.com/wienerlabs/square-solana/issues/48
[BE-16]: https://github.com/wienerlabs/square-solana/issues/49
[BE-18]: https://github.com/wienerlabs/square-solana/issues/51
[BE-24]: https://github.com/wienerlabs/square-solana/issues/79
[BE-25]: https://github.com/wienerlabs/square-solana/issues/80
[FE-01]: https://github.com/wienerlabs/square-solana/issues/21
