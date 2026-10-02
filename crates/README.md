# crates/

Programlar arasında paylaşılan Rust crate'leri. Cargo workspace üyesidir (`members = ["crates/*"]`).

| Crate | İçerik | Issue |
|---|---|---|
| [`square-common`](square-common/) | seed'ler, roller, hata kodları, programlar arası okunan hesap tipleri; event tipleri | [BC-10], [BC-16] |

Her crate `rust-version = "1.84"` bildirir: SBF derlemesi Solana platform-tools'un rustc 1.84'üyle
yapılır ve `.cargo/config.toml`'daki `incompatible-rust-versions = "fallback"` ayarı, bağımlılıkların
bu sınırı aşan sürümlere çözülmesini önler.

[BC-10]: https://github.com/wienerlabs/square-solana/issues/10
[BC-16]: https://github.com/wienerlabs/square-solana/issues/23
