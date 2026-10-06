---
'@squaresdk/solana-mcp': minor
---

Square MCP sunucusu ve havuzlu MCP istemcisi (BE-28).

Covenant `mcp/`'nin Square'e uyarlaması. Okuma tool'ları (`square_find_work`, `square_get_job`,
`square_settlement_stats`, `square_get_reputation`, `square_discover_agents`) Square REST API'sini kullanır.
Yazma tool'ları (`square_open_job`, `square_accept_job`, `square_deliver_work`) API'nin hazırladığı imzasız tx'i
özetiyle döner; `square_submit_signed_transaction` yalnızca her zorunlu imzası doğrulanmış tx'i gönderir. İsteğe
bağlı yerel imzalayıcı yalnızca açıkça yapılandırılırsa ve stdio'da çalışır. Taşımalar stdio (`square-mcp`) ve
Streamable HTTP (`square-mcp --http`). `@squaresdk/solana-mcp/client`: bağlantı yeniden kullanımı, eşzamanlılık
sınırı, yeniden bağlanma, tool keşfi önbelleği ve kapatmalı havuzlu MCP istemcisi.
