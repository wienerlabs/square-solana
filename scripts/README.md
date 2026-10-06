# scripts/

Repo düzeyindeki operasyon script'leri ([§9](../docs/analysis/square-solana-analysis.md#9-%C3%B6nerilen-monorepo-yap%C4%B1s%C4%B1)).
Init, Address Lookup Table kurulumu ve smoke SDK'yı kullandığı için bir workspace paketidir:
[`tests/smoke`](../tests/smoke/).

| Konu | Issue |
|---|---|
| [`license/`](license/): lisans envanteri, paketlerdeki `LICENSE` / `NOTICE` kopyaları ve CI kapısı (`pnpm license:check`, `pnpm license:write`) | [BC-02] |
| [`ci/`](ci/): TS CI'ının yardımcıları: PR'da derleme ve test kapsamı (`turbo-scope.mjs`), paket kurulum smoke'u (`pack-smoke.mjs`), migration kuralları (`migrations-guard.mjs`), izleme kuralları ve panosunun servis metrikleriyle uyumu (`monitoring.mjs`, BE-33); testleri `node --test "scripts/ci/*.test.mjs"` | [BE-03] |
| [`ci/`](ci/): program CI'ı: programların sözleşmeye göre durumu (`programs.mjs`), program IDL'lerinin sözleşmeyle uyumu (`idl-conformance.mjs`), Rust biçim ve lint kapsamı (`rust-lint.mjs`), araç sürümlerinin `Anchor.toml` ile aynılığı (`toolchain.mjs`) ([docs/ci.md](../docs/ci.md)) | [BC-13] |
| [`security/`](security/): gitleaks çalıştırıcısı (`gitleaks.mjs`: `staged` kancada, `history` CI'da ve `pnpm secrets:scan`'de), sabitlenen sürüm (`gitleaks.env`), Solana kurallarının testi (`gitleaks-rules.check.mjs`, gitleaks ister) | [BC-13] |
| [`hooks/`](hooks/): `pnpm install`'da git kancalarını `.githooks/`'a bağlar (`install.mjs`) | [BC-13] |
| [`deploy/`](deploy/): program kimliklerinin depoya uygulanması (`set-program-ids.mjs`; anahtar okumaz), Squads v4 multisig'inin kurulması ve doğrulanması (`squads-multisig.mjs`) ve [upgrade runbook'u](../docs/runbooks/upgrade.md) | [BC-09] |
| Address Lookup Table, compute budget, priority fee | [BC-28] |
| [`deploy/`](deploy/): ağ yapılandırması (`networks/<ağ>.json`, `network-config.mjs`), config'lerin Squads vault'u adına kurulması (`init-configs.mjs`), Square ALT'ı (`create-lookup-table.mjs`), hız sınırına dayanıklı RPC bağlantısı (`rpc.mjs`); kayıt [`docs/deploy/devnet.md`](../docs/deploy/devnet.md) | [BC-30] |
| [`deploy/`](deploy/): CCTP V2 ile fonlama: kaynak EVM zincirinde burn (`cctp-burn.mjs`), attestation ve tek tx'te mint + `fund_job` devnet koşusu (`cctp-fund-job.mjs`), ortak yardımcılar (`cctp.mjs`), CCTP ALT'ı (`create-lookup-table.mjs --cctp`); [cctp-funding.md](../docs/design/cctp-funding.md) | [BC-36] |
| Uçtan uca smoke: 8 adım ve iki varyant gerçek işlemlerle, tx / CU / ücret raporu: [`tests/smoke`](../tests/smoke/) `smoke` ve `smoke:localnet`; CI [`smoke.yml`](../.github/workflows/smoke.yml) | [BC-31] |

Anahtarlar ve secret'lar repoya girmez (`.gitignore`: `*keypair*.json`, `.env*`); deploy
keypair'leri secret store'da tutulur [BC-09].

[BC-02]: https://github.com/wienerlabs/square-solana/issues/2
[BE-03]: https://github.com/wienerlabs/square-solana/issues/17
[BC-09]: https://github.com/wienerlabs/square-solana/issues/9
[BC-13]: https://github.com/wienerlabs/square-solana/issues/13
[BC-28]: https://github.com/wienerlabs/square-solana/issues/36
[BC-30]: https://github.com/wienerlabs/square-solana/issues/38
[BC-31]: https://github.com/wienerlabs/square-solana/issues/43
[BC-36]: https://github.com/wienerlabs/square-solana/issues/77
