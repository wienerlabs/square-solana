# circuits/

Circom uyum devresi ve trusted setup belgeleri.

| Dizin | Kaynak | Issue |
|---|---|---|
| `payment-compliance/` | `aperture/circuits/payment-prover` (geçmişiyle) | [BC-06] |

- Devre, release ispatına uyarlanır: payee / net tutar / mint / günlük sayaç / saat / job bağlama
  [BC-19].
- **Prover artefaktları (`.wasm`, `.zkey`, doğrulama anahtarı) repoya girmez**; geliştirme setup'ı
  ve artefakt pipeline'ı [BC-20] ile yeniden üretilir.
- Aperture'dan gelen `payment.zkey` tek katılımcılı, sabit entropy'li bir geliştirme setup'ıdır ve
  production'a uygun değildir. Kamusal phase-2 ceremony ve doğrulama anahtarı güncellemesi [BC-38].

[BC-06]: https://github.com/wienerlabs/square-solana/issues/6
[BC-19]: https://github.com/wienerlabs/square-solana/issues/27
[BC-20]: https://github.com/wienerlabs/square-solana/issues/28
[BC-38]: https://github.com/wienerlabs/square-solana/issues/92
