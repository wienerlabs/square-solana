---
'@squaresdk/solana-types': patch
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-api': minor
---

Smart account ile çalışan roller (FE-21, API sözleşmesi v0.23.0).

`@squaresdk/solana-api`: `X-Square-Smart-Account: <multisig>` başlığı. Çağıran, Squads v4 multisig'in 0 numaralı
vault'u adına da yazar ve okur; koşul, cüzdanın multisig'te `Initiate` yetkili üye olmasıdır (üyelik zincirden o
anda okunur). Teslimat, agent kartı, politika meta verisi, Travel Rule ve dispute kanıtı uçlarında; kayıtlara
üyenin cüzdanı yazılır.

`@squaresdk/solana-sdk`: `ApiClientConfig.auth.smartAccount` başlığı her isteğe ekler.

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.23.0.
