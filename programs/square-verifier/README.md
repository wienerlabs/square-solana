# square-verifier (`verifier`)

Square's Groth16 verifier program, migrated from Aperture `programs/verifier` (BC-05, see
[`docs/provenance/BC-05.md`](../../docs/provenance/BC-05.md)). Proofs from the payment-compliance
Circom circuit are verified on chain with alt_bn128 syscalls (`groth16-solana`).

## Instructions

| Instruction | Status |
|---|---|
| `verify_mpp_payment_proof` | Active. Stripe MPP path: checks the compliance-api ed25519 attestation from the preceding Ed25519 precompile instruction, verifies the proof and advances `OperatorState` in the same instruction. |
| `initialize_operator_state` | Active. Optional one-time allocation of `OperatorState`. |

The release-proof path of the target interface (`set_compliance_proof` → `ReleaseProof`, and the
escrow-only `record_release` CPI) arrives with BC-21; see
[`docs/design/program-interface.md`](../../docs/design/program-interface.md) (BC-44).

Removed in BC-11 and BC-47: `verify_payment_proof` (RISC Zero v1), `verify_batch_attestation` (v1),
`verify_batch_attestation_v2` (zeroed-VK batch path), `record_payment` (transfer-hook entry point),
`verify_payment_proof_v2` and `verify_payment_proof_v2_with_transfer` (both depended on the
transfer hook), the `AttestationRecord` account and their error enums.

## Accounts

- `OperatorState` `["operator_state", operator]`: UTC-day spend counter used as a circuit public input.
- `ProofRecord` `["proof", operator, policy_data_hash]`: verified proof record.
- `ComplianceStatus` `["compliance", operator]`: last compliance result per operator.

## License

MIT, see [`LICENSE`](LICENSE) (original Aperture copyright).
