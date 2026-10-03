---
'@squaresdk/solana-sdk': patch
'@squaresdk/solana-policy': patch
---

`BN` artık `@coral-xyz/anchor` yerine doğrudan `bn.js`'ten alınır. Anchor 0.31.1'in exports haritası
yok; Node yalnızca CommonJS `main` girişini yükler ve orada `BN` bir getter ile dışa aktarılır. Node 24.0
ile 24.13 arasındaki cjs-module-lexer bu getter'ı adlı ESM dışa aktarımı saymadığından derlenmiş paketler
düz Node'da açılırken `BN` dışa aktarımı bulunamadı diye SyntaxError veriyordu. Kullanılan `bn.js`
kopyası anchor'unkiyle aynıdır (5.2.5). `@squaresdk/solana-policy` artık anchor'u çalışma zamanında içe
aktarmadığı için anchor paketin geliştirme bağımlılığıdır.
