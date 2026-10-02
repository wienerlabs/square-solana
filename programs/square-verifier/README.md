# Aperture ZK Verifier

Anchor program for on-chain verification of RISC Zero receipts. Creates ProofRecord and AttestationRecord accounts after successful verification.

## Instructions

| Instruction | Description |
|-------------|-------------|
| `verify_payment_proof` | Verify single payment proof, create ProofRecord PDA |
| `verify_batch_attestation` | Verify batch aggregation, create AttestationRecord PDA |

## Account Structure

**ProofRecord**: operator, policy_id, proof_hash, image_id, journal_digest, timestamp, verified
**AttestationRecord**: operator, batch_hash, image_id, journal_digest, total_payments, period range, timestamp, verified

## Verification Flow

1. Host runs RISC Zero prover off-chain, gets receipt
2. Host verifies receipt locally
3. Host submits journal digest + receipt data hash to on-chain verifier
4. Program validates hash integrity and creates verified record PDA
5. Transfer Hook checks for existence of verified ProofRecord before allowing transfers

## Build & Test

```bash
anchor build -p verifier
anchor test
```
