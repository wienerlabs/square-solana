---
'@squaresdk/solana-mcp': minor
---

İki yönlü MCP (BE-28). Square MCP sunucusu Covenant'ınkinden uyarlandı:
- **Okuma araçları:** İş bulma, job, settlement istatistikleri, itibar, agent keşfi. Square programlarının hesaplarını zincirden okur; barındırılan bir API gerekmez.
- **Yazma araçları:** Job açma ve fonlama, kabul, teslim, imzalanmış tx'in gönderilmesi. İmza akışıyla çalışır: sunucu yalnızca kendi anahtarının rolündeki tx'i imzalar, anahtar yoksa imzasız tx döner.

Agent'lar için havuzlu MCP istemcisi (`@squaresdk/solana-mcp/client`, `McpClientPool`) eklendi:
- Sunucu başına tek bağlantı ve eşzamanlılık sınırı; fazla istek sırada bekler.
- Kopan bağlantıya üstel beklemeyle yeniden bağlanma; araç çağrısı yeniden denenmez.
- Araç listesi önbelleği ve sunucular arası araç keşfi (`callToolByName`).
- Taşımalar: stdio, Streamable HTTP ve özel taşıma.
