# tests/

Programlar ve servisler için repo düzeyindeki testler. Paket ve uygulama birim testleri kendi
dizinlerinde durur.

| Test | Kapsam | Issue |
|---|---|---|
| [Program testleri](programs/) | LiteSVM harness'ı, `anchor test`, USDC / ATA fikstürleri, Squads vault imzacısı, saat ilerletme, compute unit ölçümü; dört programın örnek testleri | [BC-12] |
| Square escrow entegrasyon paketi | tüm durum geçişleri ve settlement yolları, yetki ve hesap ikamesi saldırıları, CU raporu | [BC-29] |
| [Servis entegrasyon testi](services/) (`@squaresdk/solana-services-e2e`) | Localnet'te dört program, Postgres ve S3 uyumlu depo; api, indexer, keeper, prover ve screener gerçek süreçler. 8 adım ve varyantlar SDK ve policy paketiyle (in-process ispat dahil); screening screener'dan, finalize keeper'dan, bir ispat prover servisinden. Indexer'ın bütün event'leri, keeper'ın finalize'ı ve `ProofRequired` bekletmesi, `ReleaseRefused` iadesi, screener kaydı ve işaretli tarafın fonlama reddi, uzlaştırma sapması 0 | [BE-36] |
| [Smoke](smoke/) (`@squaresdk/solana-smoke`) | Küme kurulumu (`init`: config'ler, Squads talimatları, Square ALT'ı, kayıt satırları) ve 8 adımlı smoke, ispat-ret ve ispat-yok varyantları gerçek işlemlerle, tx / CU / ücret raporu; her kümede aynı komutlar, localnet koşucusu | [BC-30], [BC-31] |

- Smoke bir pnpm workspace paketidir ([`smoke/`](smoke/)): SDK ve policy paketini kullanır, kendi birim
  testleri vardır. Localnet raporu [`docs/deploy/smoke-localnet.md`](../docs/deploy/smoke-localnet.md);
  devnet raporu gerçek deploy'la `docs/deploy/smoke-devnet.md`'de oluşur [BC-31].
- Servis entegrasyon testi de bir workspace paketidir ([`services/`](services/)): smoke'un modüllerini
  (`@squaresdk/solana-smoke/<modül>`: localnet koşucusu, `init`, `runSmoke`) yeniden kullanır, servisleri derlenmiş
  hâlleriyle açar. Komut `pnpm --filter @squaresdk/solana-services-e2e test:localnet`; CI'da
  [`services.yml`](../.github/workflows/services.yml) [BE-36].
- Covenant'ın Anchor test harness'ı (`covenant/tests/covenant.ts`) geçmişiyle
  [`tests/legacy/covenant.ts`](legacy/covenant.ts)'e taşındı [BC-04]. Referanstır; çalıştırılmaz ve
  lint / biçim denetimine girmez. Taşınabilen testler BC-29'da [`programs/`](programs/) harness'ıyla yeniden yazılır.

[BC-04]: https://github.com/wienerlabs/square-solana/issues/4
[BC-12]: https://github.com/wienerlabs/square-solana/issues/12
[BC-29]: https://github.com/wienerlabs/square-solana/issues/37
[BC-30]: https://github.com/wienerlabs/square-solana/issues/38
[BC-31]: https://github.com/wienerlabs/square-solana/issues/43
[BE-36]: https://github.com/wienerlabs/square-solana/issues/103
