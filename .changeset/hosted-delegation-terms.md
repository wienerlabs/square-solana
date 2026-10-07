---
'@squaresdk/solana-hosted': patch
---

Delegasyon kapısının bağımsız inceleme bulguları. Aynı spec'le yeniden çağrı ilk ayırmanın koşullarına (agent, tutar,
kategori) ve son tarihine bağlıdır; farklı koşul `DelegationError` ile düşer ve `create_job` defterdeki koşullarla
kurulur. Son tarihi geçmiş ve zincirde açılmamış ayırma silinir, çağrı kapıdan yeniden geçer. Aynı spec için süren
delegasyon varken ikinci çağrı düşer. UTC gününde en çok `maxJobsPerDay` (zorunlu) job açılır, aşan çağrı
`dailyJobLimit` ile reddedilir. Travel Rule deposu yalnızca bu cüzdan, nonce ve `api.authDomain` için Square oturum
mesajını imzalar; Travel Rule delegasyonu açıksa `api.authDomain` zorunludur.
