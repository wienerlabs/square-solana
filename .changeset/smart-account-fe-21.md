---
'@squaresdk/solana-types': patch
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-web': minor
---

Smart account ile çalışan roller (FE-21, API sözleşmesi v0.24.0).

`@squaresdk/solana-api`: `X-Square-Smart-Account: <multisig>` başlığı. Çağıran, Squads v4 multisig'in 0 numaralı
vault'u adına da yazar ve okur; koşul, cüzdanın multisig'te `Initiate` yetkili üye olmasıdır (üyelik zincirden o
anda okunur). Teslimat, agent kartı, politika meta verisi, Travel Rule ve dispute kanıtı uçlarında; kayıtlara
üyenin cüzdanı yazılır.

`@squaresdk/solana-sdk`: `ApiClientConfig.auth.smartAccount` başlığı her isteğe ekler. `squadsTransactionAddress` ve
`squadsProposalAddress` tarayıcıda da çalışır: u64 indeks `DataView` ile yazılır (Next.js'in Buffer polyfill'inde
`writeBigUInt64LE` yok).

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.24.0.

`@squaresdk/solana-web`: `/app/account` (FE-21). Sponsorlu gönderim (`SQUARE_FEE_PAYER_URL`, BE-27'nin servisi), rol
başına Squads v4 smart account: sponsorla açma ya da var olanı seçme, üyelik görünümü (üyeler, eşik, vault ve
bakiyeleri, öneriler; onay ve yürütme). Politika, agent kaydı, iş açma ve fonlama, kabul ve teslim, ispat, alacak ve
uyuşmazlık adımları rolün adresiyle (cüzdan ya da vault) çalışır; smart account'ta her adım vault tx'i olarak önerilir
ve yürütülür.
