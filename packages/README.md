# packages/

TypeScript paketleri (pnpm workspace). Dizin adı kısa ad, npm adı **`@squaresdk/solana-<ad>`**
([§12.4](../docs/analysis/square-solana-analysis.md#124-varsay%C4%B1lanlar)); `square` ve
`@square/*` adları kullanılmaz. Adlandırma, ortak yapılandırma ve sürümleme [BE-01] ile kurulur.

Apache-2.0 olarak yayımlanacak paket kökteki `LICENSE` ve `NOTICE`'in commit'li kopyalarını taşır
ve ikisini `files`'ta listeler ([lisans politikası](../docs/licensing.md#dağıtılan-paketler));
kopyaları `pnpm license:write` yazar, `pnpm license:check` denetler.

| Dizin | npm adı | İçerik | Issue |
|---|---|---|---|
| `config/` | `@squaresdk/solana-config` | tsconfig, eslint, prettier ortak ayarları | [BE-01] |
| [`types/`](types/) | `@squaresdk/solana-types` | ortak zod şemaları | [BE-07] |
| [`sdk/`](sdk/) | `@squaresdk/solana-sdk` | 4 program için IDL'den typed client, PDA'lar, event decoder, tx builder'lar | [BE-08] |
| [`identity/`](identity/) | `@squaresdk/solana-identity` | `did:aip` resolver (v2 Solana + v1), agent card | [BE-09] |
| [`policy/`](policy/) | `@squaresdk/solana-policy` | kurum tarafı: politika, commitment, alıcı listesi, ispat | [BE-10] |
| [`observability/`](observability/) | `@squaresdk/solana-observability` | gizli veriyi maskeleyen logger, Prometheus metrikleri, `/health` ve `/ready`, eşik alarmları | [BE-12] |
| [`hardening/`](hardening/) | `@squaresdk/solana-hardening` | SSRF, idempotency, kalıcı hız sınırı, RPC failover, cüzdan imzalı eylemler, webhook imzası ve tekrar koruması, AES-256-GCM gizli değer kutusu | [BE-13] |
| [`cctp/`](cctp/) | `@squaresdk/solana-cctp` | CCTP relayer'ın çekirdeği: burn kaydı, attestation takibi, Solana'da teslim, fonlamanın izlenmesi, kurumun mint + fonlama tx'i ([tasarım](../docs/design/cctp-funding.md#relayer-be-26)) | [BE-26] |
| [`a2a/`](a2a/) | `@squaresdk/solana-a2a` | A2A v1.0 görev protokolü (JSON-RPC 2.0 + SSE), görev ↔ job durum eşlemesi, Postgres görev deposu ([tasarım](../docs/design/a2a.md)) | [BE-17] |
| [`agent-sdk/`](agent-sdk/) | `@squaresdk/solana-agent-sdk` | agent yazma kiti: well-known agent card, A2A uç noktası, job kabulü ve teslimi (teslimat yükleme + `submit_work`), isteğe bağlı `list_claim`, `register_agent` yardımcısı; LLM işleyicisi `/anthropic` alt yolunda | [BE-19] |
| [`x402/`](x402/) | `@squaresdk/solana-x402` | x402 v2 geçidi (resmi `@x402/*` üzerine): Solana exact şeması, kendi ya da harici facilitator ([ADR 0018](../docs/decisions/0018-x402-facilitator.md)), kalıcı tekrar koruması, ücretli Express route'u, portal tanımından ücretli route (`paidRouteFromDefinition`, [ADR 0023](../docs/decisions/0023-x402-ucretli-uc-nokta-tanimlari.md)), ödeyen `fetch` | [BE-24], [FE-22] |
| [`mcp/`](mcp/) | `@squaresdk/solana-mcp` | Square MCP sunucusu (okuma ve imzasız tx hazırlayan yazma tool'ları, stdio ve Streamable HTTP) + agent'lar için havuzlu MCP istemcisi (`/client`) | [BE-28] |
| [`hosted/`](hosted/) | `@squaresdk/solana-hosted` | konfigürasyondan çalışan kurum agent'ı (`square-hosted`): capability başına yalnızca izinli MCP tool'larını gören Claude çalıştırması, kurum politikası altında delegasyon, ispat bağlama ve dispute crank'i ([ADR 0022](../docs/decisions/0022-hosted-agent-calisma-zamani-izolasyonu.md)) | [BE-29] |
| `cli/` | `@squaresdk/solana-cli` | komut satırı aracı | [BE-30] |

`mcp/` (covenant `mcp/`) ve `agent-sdk/` (aip-beta `packages/agent-sdk`) kaynak projelerden
geçmişleriyle taşındı [BE-02]. `agent-sdk/` BE-19'da (Apache-2.0; kaynağın MIT bildirimi
`agent-sdk/LICENSE-MIT`) ve `mcp/` BE-28'de Square'e uyarlandı ve yayınlanabilir paketlere katıldı. `covenant/sdk`,
`aperture/shared/types` ve aip `src/lib/{identity,protocol}` toptan taşınmadı: ilgili paketin
uygulama issue'sunda kaynak commit referansıyla işlenir (eşleme:
[`docs/provenance/BE-02.md`](../docs/provenance/BE-02.md)).

[BE-01]: https://github.com/wienerlabs/square-solana/issues/15
[BE-02]: https://github.com/wienerlabs/square-solana/issues/16
[BE-07]: https://github.com/wienerlabs/square-solana/issues/39
[BE-08]: https://github.com/wienerlabs/square-solana/issues/40
[BE-09]: https://github.com/wienerlabs/square-solana/issues/41
[BE-10]: https://github.com/wienerlabs/square-solana/issues/42
[BE-12]: https://github.com/wienerlabs/square-solana/issues/45
[BE-13]: https://github.com/wienerlabs/square-solana/issues/46
[BE-17]: https://github.com/wienerlabs/square-solana/issues/50
[BE-19]: https://github.com/wienerlabs/square-solana/issues/52
[BE-24]: https://github.com/wienerlabs/square-solana/issues/79
[BE-26]: https://github.com/wienerlabs/square-solana/issues/81
[FE-22]: https://github.com/wienerlabs/square-solana/issues/86
[BE-28]: https://github.com/wienerlabs/square-solana/issues/87
[BE-29]: https://github.com/wienerlabs/square-solana/issues/88
[BE-30]: https://github.com/wienerlabs/square-solana/issues/89
