# docs/

Proje belgeleri. Mevcut olanlar bağlantılı; diğerleri ilgili issue ile eklenir.

| Yol | İçerik | Issue |
|---|---|---|
| [`analysis/`](analysis/) | Birleştirme analizi; [§12](analysis/square-solana-analysis.md#12-kararlar) kesin kararlar | — |
| [`decisions/`](decisions/) | ADR'ler: §12 kararlarının kalıcı kaydı ([0001](decisions/0001-ts-paket-adlandirma-ve-surumleme.md): TS paket adlandırma ve sürümleme; [0002](decisions/0002-web-hosting-railway.md): web de Railway'de; 0003-0011: §12.1, §12.4 ve §12.5 kararları; [0012](decisions/0012-ispat-tazeligi-ve-gunluk-sayac.md): release ispatının tazeliği ve günlük sayaç; [0013](decisions/0013-release-keeper-ucreti-iade-ve-itibar.md): keeper ücreti, iade eden ret ve itibar; [0014](decisions/0014-alacak-piyasasi-satici-ve-alici-kurallari.md): alacak piyasasının satıcı ve alıcı kuralları; [0015](decisions/0015-travel-rule-commitment-ve-esik.md): Travel Rule commitment'ı ve eşik; [0016](decisions/0016-dispute-m-of-n-zaman-asimi-ve-ispatsiz-bekleme.md): M-of-N arbitration, dispute zaman aşımı ve ispatsız bekleme; [0017](decisions/0017-travel-rule-saklama-erisim-ve-paylasim.md): Travel Rule kaydının saklanması, erişimi ve paylaşımı; [0018](decisions/0018-x402-facilitator.md): x402 facilitator'ı; [0019](decisions/0019-fee-payer-politikasi.md): fee payer politikası; [0020](decisions/0020-sanctions-screening-kaynaklari-ve-saglayici.md): sanctions screening kaynakları ve sağlayıcı) ve [şablon](decisions/sablon.md) | [BE-06], [BE-01] |
| [`did-aip/`](did-aip/) | [`did:aip` v2 Solana (CAIP-2) profil spesifikasyonu](did-aip/method-spec-v2-solana.md) ve [test vektörleri](did-aip/test-vectors.json) | [BC-14] |
| [`design/`](design/) | [program arayüz sözleşmesi](design/program-interface.md), [API ve SDK sözleşmesi](design/api-sdk-contract.md), [veri modeli](design/data-model.md), [normatif event şeması](design/events.md), [işlem bütçesi](design/tx-budget.md), [CCTP ile fonlama](design/cctp-funding.md) | [BC-44], [BE-35], [BE-04], [BC-16], [BC-28], [BC-36] |
| [`api/`](api/) | [OpenAPI 3.1 spec](api/openapi.yaml) (48 operasyon); [`schemas/idl.json`](api/schemas/idl.json) IDL'den üretilen JSON Schema'lar, elle düzenlenmez | [BE-35] |
| [`provenance/`](provenance/) | taşınan dizinlerin kaynak repo, commit ve yöntem kayıtları (issue başına bir dosya) | [BC-04], [BC-05], [BC-06], [BC-07], [BE-02] |
| [`environments.md`](environments.md) | ortamlar (PR preview, staging, production), secret politikası ve servislerin ortam değişkeni envanteri (üretilir) | [BE-05] |
| [`ci.md`](ci.md) | CI kontrolleri, program durum listesi, sır taraması, verifiable build ve merge kuralı | [BE-03], [BC-12], [BC-13] |
| [`slo.md`](slo.md) | SLO'lar, hata bütçesi ve burn-rate politikası; panolar ve alarm kuralları [`infra/monitoring/`](../infra/monitoring/)'da | [BE-33] |
| [`licensing.md`](licensing.md) | lisans politikası: proje lisansı, taşınan kodun bildirimleri, bağımlılık lisansları | [BC-02] |
| [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) | üçüncü taraf lisans envanteri (üretilir) | [BC-02] |
| `legal/relicensing/` | Covenant LGPL kodu için yazılı yeniden lisanslama onayları | [BC-03] |
| [`deploy/`](deploy/) | ağ bazında deploy kayıtları (`devnet.md` ilk devnet deploy'uyla oluşur) ve smoke raporları ([`smoke-localnet.md`](deploy/smoke-localnet.md); üreten [`tests/smoke`](../tests/smoke/)) | [BC-30], [BC-31] |
| [`runbooks/`](runbooks/) | operasyon runbook'ları ([`upgrade.md`](runbooks/upgrade.md)) | [BC-09] |

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
[BC-28]: https://github.com/wienerlabs/square-solana/issues/36
[BC-30]: https://github.com/wienerlabs/square-solana/issues/38
[BC-31]: https://github.com/wienerlabs/square-solana/issues/43
[BC-36]: https://github.com/wienerlabs/square-solana/issues/77
[BC-44]: https://github.com/wienerlabs/square-solana/issues/101
[BE-01]: https://github.com/wienerlabs/square-solana/issues/15
[BE-04]: https://github.com/wienerlabs/square-solana/issues/18
[BE-02]: https://github.com/wienerlabs/square-solana/issues/16
[BE-06]: https://github.com/wienerlabs/square-solana/issues/20
[BE-35]: https://github.com/wienerlabs/square-solana/issues/102
[BE-33]: https://github.com/wienerlabs/square-solana/issues/95
[BE-03]: https://github.com/wienerlabs/square-solana/issues/17
[BE-05]: https://github.com/wienerlabs/square-solana/issues/19
