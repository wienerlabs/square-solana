---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-policy': minor
---

Program sözleşmesi v0.7.0 (API sözleşmesi v0.23.0): Stripe MPP fiat rayı (BC-37, ADR 0024).
- IDL tipleri ve şemaları: `Job.rail` (`SettlementRail`), `create_fiat_job`, `cancel_fiat_job`, `finalize_fiat_payment`, `FiatJobCreated`, `verify_mpp_payment_proof` (yol A), `update_mpp_authority`, `MppPaymentVerified.job`, `RailMismatch` (escrow 6049, verifier 6011).
- SDK: `mppAttestationMessage`, `mppAttestationInstruction`, `MPP_ATTESTATION_DOMAIN`, `MPP_ATTESTATION_MESSAGE_LENGTH`; `flow.createFiatJob`, `flow.cancelFiatJob`, `flow.finalizeFiatPayment`; işlem profilinde fiat tx türleri ve yükseltilen sınırlar (`setPolicy`, `recordScreening`, `fundJob`, `buyClaim`, `finalizePayment`, `setComplianceProof`).
- Policy: `buildVerifyMppPaymentProofTx`; `buildReleaseWitness` fiat işte `stripeReceiptHash` ister, net tutarın tamamıdır.
