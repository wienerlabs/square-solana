# crates/

Programlar arasında paylaşılan Rust crate'leri. Cargo workspace üyesidir (`members = ["crates/*"]`).

| Crate | İçerik | Issue |
|---|---|---|
| [`square-common`](square-common/) | seed'ler, roller, ortak sabitler, UTC gün başlangıcı, owner/seed doğrulamalı account-read, programlar arası okunan hesap tipleri [BC-10] ✓; event tipleri ve programların event'leri tanımlayan makroları [BC-16] ✓ | [BC-10], [BC-16] |

`square-common`:

- **Hesap tipleri ve sözleşme seed'leri:** Sözleşme IDL'lerinden `declare_program!` ile üretilir. `idls/`, repo kökündeki
  [`idl/`](../idl/)'a sembolik bağdır; seed'ler IDL'in `constants` bölümündedir, crate'te yeniden yazılmaz.
- **Taşınan programlara özgü seed'ler:** Sözleşmede karşılığı olmayan seed'ler `seeds::legacy`'de durur ve programlar
  sözleşmeye geçtikçe kalkar. Squads v4 seed'leri `seeds::squads`'tadır.
- **`account_read`:** Hesabın owner'ını ve adresini (seed'lerden türetilen PDA) doğrular, sonra discriminator
  denetimiyle çözer. Owner, IDL'deki adres değil, okuyan programın config'inde tuttuğu program kimliğidir
  ([program arayüzü §4](../docs/design/program-interface.md#4-programlar-aras%C4%B1-eri%C5%9Fim)).

- **`events`:** Sözleşme event'leri ve `square_<program>_events!()` makroları. Makrolar `build.rs` ile IDL'den
  üretilir; program bunları crate kökünde çağırınca event'ler programın IDL'ine girer
  ([event şeması](../docs/design/events.md)).

Her crate `rust-version = "1.89"` bildirir: SBF derlemesi Agave 4.1.2'nin platform-tools v1.54'ünün
rustc 1.89'uyla yapılır. `.cargo/config.toml`'daki `incompatible-rust-versions = "fallback"` ayarı,
bağımlılıkların bu sınırı aşan sürümlere çözülmesini önler.

[BC-10]: https://github.com/wienerlabs/square-solana/issues/10
[BC-16]: https://github.com/wienerlabs/square-solana/issues/23
