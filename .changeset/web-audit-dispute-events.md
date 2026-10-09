---
'@squaresdk/solana-web': patch
---

Denetim sayfası dispute'lu işte çökmüyor: API'nin event'lerindeki karar tip biçiminde (`{ kind }`) gelir ve artık
okunur. Zaman çizelgesi `DisputeVoteRejected`'ı (ret oyu, ADR 0028) açıklar.
