---
'@squaresdk/solana-x402': minor
'@squaresdk/solana-compliance-api': patch
'@squaresdk/solana-web': patch
---

Gateway'in bağımsız inceleme bulguları.

`@squaresdk/solana-x402`: Kendi facilitator'ı (`mode: 'self'`) zorunlu `limits` ister (`maxComputeUnits`,
`maxPriorityFeeMicroLamports`, `maxRequiredSignatures`, pozitif tamsayı); facilitator'ın cüzdanından ödenecek ücretin
üst sınırı operatörün kararıdır, varsayılanı yoktur (geriye uyumsuz). Sınırı aşan ödeme doğrulamada, facilitator
imzalamadan önce reddedilir. `after-handler` akışında uzlaştırma düşerse başlıklar işleyiciden önceki değerlerine
döner; işleyicinin eklediği ya da değiştirdiği başlık (ör. ücretli oturum çerezi) 402 yanıtında kalmaz, `Date` yine
yazılır. `settle_failed` olayı bilinen işlem imzasını taşır. `onEvent`'in fırlattığı hata ve döndürdüğü promise'in
reddi yutulur, isteğin akışını değiştirmez. `res.locals.squareX402` yalnızca ödeme bilgisini taşır; serileştirilebilir
ve kopyalanabilir.

`@squaresdk/solana-compliance-api`: kendi facilitator'ın sınırları `X402_FACILITATOR_MAX_COMPUTE_UNITS`,
`X402_FACILITATOR_MAX_PRIORITY_FEE_MICRO_LAMPORTS` ve `X402_FACILITATOR_MAX_SIGNATURES`'tan gelir; `X402_FACILITATOR_URL`
yoksa üçü de zorunludur.

`@squaresdk/solana-web`: geliştirici portalının ücretli route örneği sınırları ortamdan verir.
