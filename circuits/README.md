# circuits/

Circom uyum devresi ve trusted setup belgeleri.

| Dizin | Kaynak | Issue |
|---|---|---|
| [`payment-compliance/`](payment-compliance/) | `aperture/circuits/payment-prover` (geçmişiyle) | [BC-06] ✓ |

- Devre, release ispatına uyarlanır: payee / net tutar / mint / günlük sayaç / saat / job bağlama
  [BC-19].
- Release artefaktları (`payment.zkey`, doğrulama anahtarı, `manifest.json`)
  `payment-compliance/artifacts/`'tadır ve artefakt pipeline'ı [BC-20] ile yeniden üretilip denetlenir;
  `.wasm` repoya girmez, devreden derlenir (sha256'sı manifest'te). Prover servisi bunları kullanır
  [BE-11].
- `payment.zkey` tek katılımcılı bir geliştirme setup'ıdır ve production'a uygun değildir. Kamusal
  phase-2 ceremony ve doğrulama anahtarı güncellemesi [BC-38].

[BC-06]: https://github.com/wienerlabs/square-solana/issues/6
[BC-19]: https://github.com/wienerlabs/square-solana/issues/27
[BC-20]: https://github.com/wienerlabs/square-solana/issues/28
[BC-38]: https://github.com/wienerlabs/square-solana/issues/92
[BE-11]: https://github.com/wienerlabs/square-solana/issues/44
