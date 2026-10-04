# tests/

Programlar ve servisler için repo düzeyindeki testler. Paket ve uygulama birim testleri kendi
dizinlerinde durur.

| Test | Kapsam | Issue |
|---|---|---|
| Program testleri | Altyapı [`crates/square-testkit`](../crates/square-testkit/): LiteSVM harness'ı, `anchor test`, USDC / ATA fikstürleri, Squads vault imzacısı, saat ilerletme, event çözme, compute unit ölçümü. Testler her programın kendi `programs/<program>/tests/` dizininde | [BC-12] |
| Square escrow entegrasyon paketi | tüm durum geçişleri ve settlement yolları, yetki ve hesap ikamesi saldırıları, CU raporu | [BC-29] |
| Servis entegrasyon testi | 8 adım, SDK ve servisler üzerinden gerçek programlara karşı (localnet) | [BE-36] |

- Devnet'te gerçek işlemlerle 8 adımlı smoke testi bir script'tir ve [`scripts/`](../scripts/)
  altında durur [BC-31].
- Covenant'ın Anchor test harness'ı (`covenant/tests/covenant.ts`) geçmişiyle
  [`tests/legacy/covenant.ts`](legacy/covenant.ts)'e taşındı [BC-04]. Referanstır; çalıştırılmaz ve
  lint / biçim denetimine girmez. Taşınabilen testler BC-29'da [`square-testkit`](../crates/square-testkit/) ile yeniden yazılır.

[BC-04]: https://github.com/wienerlabs/square-solana/issues/4
[BC-12]: https://github.com/wienerlabs/square-solana/issues/12
[BC-29]: https://github.com/wienerlabs/square-solana/issues/37
[BC-31]: https://github.com/wienerlabs/square-solana/issues/43
[BE-36]: https://github.com/wienerlabs/square-solana/issues/103
