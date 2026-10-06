---
'@squaresdk/solana-agent-sdk': minor
'@squaresdk/solana-types': patch
---

Agent yazma kiti (BE-19, sözleşme v0.15.1).

`@squaresdk/solana-agent-sdk`: Square'e uyarlanmış yeniden yazım, geriye uyumsuz. ESM ve Apache-2.0 (kaynağın MIT
bildirimi `LICENSE-MIT`). `createAgent` artık asenkron ve Express yerine `@squaresdk/solana-a2a`'nın A2A v1.0
sunucusunu kullanır: agent card `/.well-known/agent-card.json`'da RFC 8785 baytlarıyla (beceriler, settlement
mint cinsinden fiyatlar, did:aip v2 Solana DID'i, `supportedInterfaces`), A2A uç noktası `/a2a`'da. Gelen görev
zincirdeki job'a bağlanır; agent spec, capability, fiyat, cüzdan ve deadline'ı denetleyip `accept_job` gönderir,
işleyicinin çıktısını teslimat olarak yükler (`uploadDelivery`), makbuzu doğrular ve `submit_work` gönderir.
`autoListClaim: { discountBps }` teslimden sonra `list_claim` gönderir. `agent.register()` `register_agent` /
`update_agent` yardımcısıdır (kart agent'ta ya da API'de barındırılır). Standart dışı `task/create` /
`task/status` ve `/.well-known/agent.json` kaldırıldı. `haiku()` yerine `@squaresdk/solana-agent-sdk/anthropic`
altında `anthropicHandler` (`@anthropic-ai/sdk` isteğe bağlı peer, varsayılan model
`claude-haiku-4-5-20251001`, anahtar yalnızca ortamdan).

`@squaresdk/solana-types`: `AgentCardSchema`'ya isteğe bağlı `supportedInterfaces` (A2A v1.0 `AgentInterface`,
`AgentInterfaceSchema`); verilirse kartın `url`'i ile aynı bir girdi içermeli. `API_CONTRACT_VERSION` 0.15.1.
