---
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-types': minor
'@squaresdk/solana-cctp': minor
'@squaresdk/solana-api': minor
'@squaresdk/solana-keeper': minor
'@squaresdk/solana-db': minor
---

CCTP relayer (BE-26, API sözleşmesi v0.18.0):
- **SDK:** CCTP'nin kaynak zincir tarafı (`cctpBurnCall`, `cctpApproveCall`, ABI'ler, `cctpMaxFee`, `cctpMintRecipient`) ve Circle'ın attestation servisi (`fetchCctpAttestation`, `fetchCctpFees`); `cctpUsedNonceAddress`, `isCctpNonceUsed`, `cctpContextForMessage`. `flow.receiveAndFundJob` kurumun USDC hesabı yoksa aynı tx'te açar. `SquareApi`'ye dört CCTP metodu.
- **Types:** `CctpTransfer`, `CctpTransferStatus`, `CctpTransferCreate`, `CctpTransferQuery`, `CctpFundTxRequest`, `CctpFundTx`. `API_CONTRACT_VERSION` 0.18.0 oldu.
- **Yeni paket `@squaresdk/solana-cctp`:** Burn kaydı, kurumun mint + fonlama tx'i ve relayer'ın durum makinesi.
- **API:** `POST /v1/cctp/transfers`, `GET /v1/cctp/transfers`, `GET /v1/cctp/transfers/{transfer}`, `POST /v1/cctp/transfers/{transfer}/tx`; `API_CCTP_*` değişkenleri.
- **Keeper:** `KEEPER_CCTP_*` verilirse ikinci döngüde CCTP relayer'ı; `keeper_cctp_transitions_total`, `keeper_cctp_open_transfers`.
- **DB:** `cctp_transfers` CCTP V2'ye göre (32 baytlık nonce, attestation'dan önce boş alanlar, kurum, deneme ve bir sonraki bakış).
