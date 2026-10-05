---
"@squaresdk/solana-sdk": minor
"@squaresdk/solana-policy": minor
"@squaresdk/solana-types": minor
---

İşlem profili (BC-28, API sözleşmesi v0.10.0):
- SDK'ya her tx türünün ölçülmüş compute unit sınırı eklendi (`TX_COMPUTE_UNIT_LIMITS`, `computeUnitLimitFor`, `withComputeProfile`).
- Square address lookup table'ı için `squareLookupTableAddresses` ve `createLookupTableInstructions` eklendi.
- `flow.*` (dispute akışları hariç) ve `buildSetComplianceProofTx`, çağıran sınır vermezse profilin sınırını ekliyor.
- `buildTx`, pakete (1232 bayt) sığmayan tx'i reddediyor.
- `API_CONTRACT_VERSION` 0.10.0 oldu.
