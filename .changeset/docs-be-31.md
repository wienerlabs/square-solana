---
'@squaresdk/solana-sdk': patch
'@squaresdk/solana-types': patch
'@squaresdk/solana-mcp': patch
---

Geliştirici dokümantasyonu (BE-31, API sözleşmesi v0.18.1):
- **SDK:** Her dışa aktarım ve arayüz üyesi açıklamalı; `pnpm docs:check` denetler.
- **README'ler:** SDK ve identity'ye eklendi.
- **OpenAPI:** Her parametrenin açıklaması eklendi. Şemalar ve imzalar değişmedi.
- **mcp:** `JobFilter`, `JobStatusName` ve `Located` tipleri dışa açıldı.
