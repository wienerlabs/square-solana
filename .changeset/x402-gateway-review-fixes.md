---
'@squaresdk/solana-x402': patch
---

Gateway'in bağımsız inceleme bulguları. Kendi facilitator'ı resmi exact şemasını varsayılan sınırlarla kurar
(`SELF_FACILITATOR_LIMITS`: en çok 100 000 CU, 50 000 micro-lamport/CU priority fee, 2 imza; `scheme` ile ezilir,
`undefined` alan varsayılanı korur), böylece ödeyen facilitator'ın cüzdanına sınırsız ücret ödetemez.
`after-handler` akışında uzlaştırma düşerse başlıklar işleyiciden önceki değerlerine döner; işleyicinin eklediği ya
da değiştirdiği başlık (ör. ücretli oturum çerezi) 402 yanıtında kalmaz. `settle_failed` olayı bilinen işlem
imzasını taşır. `onEvent`'in fırlattığı hata ve döndürdüğü promise'in reddi yutulur, isteğin akışını değiştirmez.
`res.locals.squareX402` yalnızca ödeme bilgisini taşır ve serileştirilebilir.
