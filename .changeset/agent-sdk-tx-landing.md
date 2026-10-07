---
'@squaresdk/solana-agent-sdk': patch
---

Job yürütücüsünün bağımsız inceleme bulguları. `InvalidStatus` reddinden sonraki okuma düşerse ya da geride kalırsa
(gönderimden önceki durumda ya da kabulün gerisinde) ret geçici sayılır ve kabul edilmiş ya da teslim edilmiş iş
bırakılmaz; job iptal edilmişse ret kalıcıdır. Job zincirde başka bir `workHash`'le teslim edilmişse yerel çıktı
sunulmaz, `onError`'a bildirilir ve tamamlanma metni zincirdeki `workHash` ile `deliveryUri`'yi taşır. Tx'ler ve
kararı veren job okumaları `commitment` `processed` olsa da en az `confirmed` ile yapılır; `max` ve `root`
`finalized` sayılır. `AgentTxError` program hatasının adını `errorName`'de taşır.
