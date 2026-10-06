---
'@squaresdk/solana-policy': minor
'@squaresdk/solana-types': minor
---

Release kuralları tek yerde (API sözleşmesi v0.14.0).

`@squaresdk/solana-policy`: `square_common::release` ile aynı kurallar dışa aktarılır: `REFUSAL`, `refusalRules`, `isFinalRefusal`, `dayStart`, `dailySpentAt`, `releaseNetAmount`, `checkFresh`, `CLOCK_TOLERANCE_SECS`; Rust ile ortak vektörlerle denetlenir. Geriye uyumsuz: `watchJobProof`'tan `refreshBeforeSecs` çıktı. İzleyici ispatı escrow'un tazelik kuralıyla değerlendirir: UTC günü değişince ispatı yeniler (önceden gün dönümünü kaçırıyordu) ve `proof_timeout_secs`'i ispatın süresi saymaz (aynı gün içinde gereksiz yenileme yapmaz). `buildReleaseWitness`, kurumun sayacı ispat anından yeni bir güne aitse fırlatır.

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.14.0.
