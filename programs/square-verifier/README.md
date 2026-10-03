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

## Verifying keys

| Constant | File | Circuit | Used by |
|---|---|---|---|
| `APERTURE_PAYMENT_VK` (10 inputs) | `src/groth16_vk.rs` | Aperture's payment circuit, single-party dev setup | `verify_mpp_payment_proof`, until BC-37 moves it to the release circuit and removes this key |
| `SQUARE_RELEASE_VK` (13 inputs) | `src/release_vk.rs`, generated | `circuits/payment-compliance` release circuit; PPoT phase 1, **development** phase 2 (BC-20) | `set_compliance_proof` (BC-21) |

`src/release_vk.rs` is written by `circuits/payment-compliance/scripts/release-artifacts.mjs`
and checked against the committed zkey (`check`). `cargo test -p verifier` verifies a real proof
under it (`src/release_vk_vector.rs`, also generated) and rejects every single-signal change.
Phase 2 is development-only and carries no assurance; see the circuit README's Disclosure.

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
