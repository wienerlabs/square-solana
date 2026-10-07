---
'@squaresdk/solana-hosted': patch
---

Delegasyon kapısının bağımsız inceleme bulguları. Aynı spec'le yeniden çağrı ilk ayırmanın koşullarına (agent, tutar,
kategori) bağlıdır; farklı koşul `DelegationError` ile düşer ve `create_job` defterdeki koşullarla kurulur. UTC gününde
en çok `maxJobsPerDay` (varsayılan 20) job açılır, aşan çağrı `dailyJobLimit` ile reddedilir. Travel Rule deposu
yalnızca bu cüzdan ve nonce için Square oturum mesajını imzalar.
