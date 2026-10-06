---
'@squaresdk/solana-fee-payer': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-db': minor
'@squaresdk/solana-api': patch
---

Fee payer (sponsorlu işlem) servisi ve Squads v4 smart account yardımcıları (BE-27, API sözleşmesi v0.20.0, ADR 0019).

`@squaresdk/solana-fee-payer`: ilk sürüm. `POST /v1/sponsor` kullanıcının v0 tx'ini çözüp denetler (izinli program ve talimat listesi, sponsor anahtarının yalnızca ücret / rent yerlerinde durması, System talimatında sponsor yasağı, compute budget tavanı, ALT çözümü, Squads vault mesajlarının denetimi), simüle eder, tx başına tavan ve kullanıcı başına / toplam günlük lamport bütçesiyle (Postgres, advisory kilit) imzalar ya da gönderir. Kimlik API'nin oturumu ya da `tx:prepare` kapsamlı anahtarı; cüzdan başına hız sınırı. Maliyet metrikleri (ücret, rent, CU, kullanıcının günlük toplamı, sponsor bakiyesi) ve `sponsored_txs` günlüğü; `fee_payer_balance_low` alarmı.

`@squaresdk/solana-sdk`: yeni alt yol `@squaresdk/solana-sdk/squads` (resmi `@sqds/multisig` 2.1.4 üzerine): `square_common::squads` ile aynı adres türetmeleri, `createSmartAccountInstruction` (`multisig_create_v2`), `wrapInVault` (öneri ve yürütme talimatları), `builtTxInstructions`, smart account ve VaultTransaction çözücüleri, Squads talimat tablosu.

`@squaresdk/solana-types`: `API_CONTRACT_VERSION` 0.20.0.

`@squaresdk/solana-db`: `sponsored_txs` tablosu ve `SponsoredTxStatus` (migration `20261006180000_fee_payer`).

`@squaresdk/solana-api`: Squads program kimliği, `Multisig` discriminator'ı ve `Initiate` biti SDK'nın Squads yardımcılarından.
