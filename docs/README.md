# docs/

Proje belgeleri. Mevcut olanlar bağlantılı; diğerleri ilgili issue ile eklenir.

| Yol | İçerik | Issue |
|---|---|---|
| [`analysis/`](analysis/) | Birleştirme analizi; [§12](analysis/square-solana-analysis.md#12-kararlar) kesin kararlar | — |
| [`decisions/`](decisions/) | ADR'ler: §12 kararlarının kalıcı kaydı ([0001](decisions/0001-ts-paket-adlandirma-ve-surumleme.md): TS paket adlandırma ve sürümleme; [0002](decisions/0002-web-hosting-railway.md): web de Railway'de; 0003-0011: §12.1, §12.4 ve §12.5 kararları) ve [şablon](decisions/sablon.md) | [BE-06], [BE-01] |
| [`did-aip/`](did-aip/) | [`did:aip` v2 Solana (CAIP-2) profil spesifikasyonu](did-aip/method-spec-v2-solana.md) ve [test vektörleri](did-aip/test-vectors.json) | [BC-14] |
| [`design/`](design/) | [program arayüz sözleşmesi](design/program-interface.md), [API ve SDK sözleşmesi](design/api-sdk-contract.md), [veri modeli](design/data-model.md), [normatif event şeması](design/events.md) | [BC-44], [BE-35], [BE-04], [BC-16] |
| [`api/`](api/) | [OpenAPI 3.1 spec](api/openapi.yaml) (28 operasyon); [`schemas/idl.json`](api/schemas/idl.json) IDL'den üretilen JSON Schema'lar, elle düzenlenmez | [BE-35] |
| [`provenance/`](provenance/) | taşınan dizinlerin kaynak repo, commit ve yöntem kayıtları (issue başına bir dosya) | [BC-04], [BC-05], [BC-06], [BC-07], [BE-02] |
| [`ci.md`](ci.md) | CI kontrolleri, program durum listesi, sır taraması, verifiable build ve merge kuralı | [BE-03], [BC-12], [BC-13] |
| [`licensing.md`](licensing.md) | lisans politikası: proje lisansı, taşınan kodun bildirimleri, bağımlılık lisansları | [BC-02] |
| [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | üçüncü taraf lisans envanteri (üretilir) | [BC-02] |
| `legal/relicensing/` | Covenant LGPL kodu için yazılı yeniden lisanslama onayları | [BC-03] |
| `deploy/` | ağ bazında deploy kayıtları (ör. `devnet.md`) | [BC-30] |
| `runbooks/` | operasyon runbook'ları (ör. `upgrade.md`) | [BC-09] |

[BC-02]: https://github.com/wienerlabs/square-solana/issues/2
[BC-03]: https://github.com/wienerlabs/square-solana/issues/3
[BC-04]: https://github.com/wienerlabs/square-solana/issues/4
[BC-05]: https://github.com/wienerlabs/square-solana/issues/5
[BC-06]: https://github.com/wienerlabs/square-solana/issues/6
[BC-07]: https://github.com/wienerlabs/square-solana/issues/7
[BC-12]: https://github.com/wienerlabs/square-solana/issues/12
[BC-13]: https://github.com/wienerlabs/square-solana/issues/13
[BC-09]: https://github.com/wienerlabs/square-solana/issues/9
[BC-14]: https://github.com/wienerlabs/square-solana/issues/14
[BC-16]: https://github.com/wienerlabs/square-solana/issues/23
[BC-30]: https://github.com/wienerlabs/square-solana/issues/38
[BC-44]: https://github.com/wienerlabs/square-solana/issues/101
[BE-01]: https://github.com/wienerlabs/square-solana/issues/15
[BE-04]: https://github.com/wienerlabs/square-solana/issues/18
[BE-02]: https://github.com/wienerlabs/square-solana/issues/16
[BE-06]: https://github.com/wienerlabs/square-solana/issues/20
[BE-35]: https://github.com/wienerlabs/square-solana/issues/102
[BE-03]: https://github.com/wienerlabs/square-solana/issues/17
