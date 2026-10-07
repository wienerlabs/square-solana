---
'@squaresdk/solana-types': minor
'@squaresdk/solana-sdk': minor
'@squaresdk/solana-policy': minor
---

Stripe MPP fiat ödemesi (BE-25, ADR 0026; API sözleşmesi v0.24.0).
- types: `FiatConfig`, `FiatSetupIntentCreate`, `FiatSetupIntent`, `FiatCard`, `FiatCustomer`, `FiatPaymentCreate`, `FiatPayment`, `FiatAttestation`, `StripeWebhookReceipt` ve enum'lar; `ApiKeyScope`'a `fiat:pay`, `ApiErrorCode`'a `payment_required`, `payment_failed`, `payment_unavailable`.
- sdk: `SquareApi`'ye `getFiatConfig`, `createFiatSetupIntent`, `getFiatCustomer`, `createFiatPayment`, `payFiatJobMpp` (402'yi `mppx/client` fetch'i karşılar), `getFiatAttestation`, `reconcileFiatPayment`, `receiveStripeWebhook`.
- policy: `watchJobProof`'a `mppAttestation`; fiat işin bayatlayan ispatı attestation ile `verify_mpp_payment_proof`'a yeniden bağlanır. `MppAttestation` tipi.
