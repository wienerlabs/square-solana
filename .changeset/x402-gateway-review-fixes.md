---
'@squaresdk/solana-x402': patch
---

Gateway'in bağımsız inceleme bulguları. Kendi facilitator'ı resmi exact şemasını varsayılan sınırlarla kurar
(`SELF_FACILITATOR_LIMITS`: en çok 100 000 CU, 50 000 micro-lamport/CU priority fee, 2 imza; `scheme` ile ezilir),
böylece ödeyen facilitator'ın cüzdanına sınırsız ücret ödetemez. `after-handler` akışında uzlaştırma düşerse
işleyicinin koyduğu başlıklar 402 yanıtından atılır. `settle_failed` olayı bilinen işlem imzasını taşır. `onEvent`'in
fırlattığı hata yutulur ve isteğin akışını değiştirmez.
