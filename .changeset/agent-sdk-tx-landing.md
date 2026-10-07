---
'@squaresdk/solana-agent-sdk': patch
---

Job yürütücüsünün bağımsız inceleme bulguları. `InvalidStatus` reddinden sonraki okuma düşerse ya da geride kalırsa
ret geçici sayılır ve kabul edilmiş ya da teslim edilmiş iş bırakılmaz. Job zincirde başka bir `workHash`'le teslim
edilmişse yerel çıktı sunulmaz. Tx'ler `commitment` `processed` olsa da en az `confirmed` ile onaylanır.
`AgentTxError` program hatasının adını `errorName`'de taşır.
