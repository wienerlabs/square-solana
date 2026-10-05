# programs/

Square'in Anchor programları. Tek Anchor workspace'inde derlenir; programlar birbirini öncelikle
**account-read** ile (owner + seed kontrolüyle) okur, CPI yalnızca gerektiğinde kullanılır.

| Dizin (crate) | Kaynak | Taşıma | Square işleri |
|---|---|---|---|
| `square-escrow` | `covenant/programs/covenant` | [BC-04] ✓ | job yaşam döngüsü, finalize + keeper fee, proof-gated release, alacak piyasası, itibar, M-of-N arbitration, dispute timeout |
| `square-policy` | `aperture/programs/policy-registry` | [BC-05] ✓ | kurum + politika commitment'ı + public günlük tavan [BC-17] ✓, alıcı Merkle kökü [BC-18] ✓ |
| `square-verifier` (`verifier`) | `aperture/programs/verifier` | [BC-05] ✓ | Groth16 doğrulama, release ispatı bağlama (`ReleaseProof`) |
| `square-registry` | `dr-wilson-empty/aip-beta` → `programs/aip-escrow/programs/aip-registry` | [BC-07] ✓ | agent kaydı (`did:aip` v2 Solana profili), event'ler [BC-15] ✓; registry config'i ve screening [BC-27] |

- Programlar **geçmişleriyle** taşınır (`git subtree` ya da `git filter-repo`); kaynak repo, commit ve
  yöntem issue başına bir dosyada kaydedilir: [`docs/provenance/`](../docs/provenance/). Kaynağın
  `LICENSE` dosyası program dizininde korunur.
- **Taşınmayanlar:** AIP `aip_escrow`, Aperture `transfer-hook`. Verifier'ın RISC Zero v1 ve batch
  instruction'ları geçmişle birlikte geldi ve [BC-11] ile kaldırıldı.
- Tek Anchor sürümü 1.2.0 [BC-08] ✓ ([ADR 0007](../docs/decisions/0007-anchor-surumu.md)), yeni program ID'leri ve 2-of-3 Squads upgrade authority [BC-09].
- Dış arayüz sözleşmesi (instruction / account / PDA / event) [BC-44] ile önce sabitlenir:
  [`docs/design/program-interface.md`](../docs/design/program-interface.md). Sözleşmenin tek kaynağı
  [`idl/`](../idl/) altındaki IDL'lerdir.
- Paylaşılan seed'ler, roller, hata kodları ve event tipleri [`crates/square-common`](../crates/).
- Programın sözleşmeye göre durumu (`contract` / `legacy`) [`scripts/ci/programs.mjs`](../scripts/ci/programs.mjs)'tedir.
  Sözleşmeye geçen programın derlenen IDL'i sözleşme IDL'iyle aynı olmalı ve crate'i `cargo fmt` ile
  `cargo clippy -D warnings`'ten geçmeli; CI denetler ([docs/ci.md](../docs/ci.md)) [BC-13].

[BC-04]: https://github.com/wienerlabs/square-solana/issues/4
[BC-05]: https://github.com/wienerlabs/square-solana/issues/5
[BC-07]: https://github.com/wienerlabs/square-solana/issues/7
[BC-08]: https://github.com/wienerlabs/square-solana/issues/8
[BC-09]: https://github.com/wienerlabs/square-solana/issues/9
[BC-11]: https://github.com/wienerlabs/square-solana/issues/11
[BC-13]: https://github.com/wienerlabs/square-solana/issues/13
[BC-15]: https://github.com/wienerlabs/square-solana/issues/24
[BC-17]: https://github.com/wienerlabs/square-solana/issues/25
[BC-18]: https://github.com/wienerlabs/square-solana/issues/26
[BC-27]: https://github.com/wienerlabs/square-solana/issues/35
[BC-44]: https://github.com/wienerlabs/square-solana/issues/101
