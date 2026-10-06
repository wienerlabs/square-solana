---
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
---

CCTP V2 ile fonlama (BC-36, API sözleşmesi v0.17.0, program sözleşmesi v0.5.1). SDK'ya şunlar eklendi:
- Başka zincirde yakılan USDC'nin Solana'da mint edilmesi için Circle'ın `receive_message` talimatı (`receiveMessageInstruction`).
- Mesaj çözücü (`decodeCctpMessage`, `cctpMintedAmount`).
- Circle'ın PDA'ları ve CCTP ALT adresleri (`cctpStaticAccounts`, `cctpLookupTableAddresses`).
- Ücret alıcısının okunması (`fetchCctpFeeRecipient`).
- Mint ile `fund_job`'u tek tx'te kuran `flow.receiveAndFundJob`.

`receive_message`'ın compute payı devnet ölçümünden gelir (`CCTP_RECEIVE_COMPUTE_UNITS`). `API_CONTRACT_VERSION` 0.17.0 oldu.
