# Aperture Prover Service

Node.js HTTP service that wraps [snarkjs](https://github.com/iden3/snarkjs)
to generate Groth16 proofs for the Aperture payment compliance circuit.

This is the replacement for the archived RISC Zero prover that used to
live at `_archive/risc0/services/prover-service/`. It speaks the same
request format so `agent-service` and `compliance-api` do not need
changes beyond updating `PROVER_SERVICE_URL`.

## Why this exists

The Circom pipeline produces standard Groth16 proofs over BN254, which
`groth16-solana` can verify on-chain within Solana's 1.4M CU limit. The
old RISC Zero path required Docker-based STARK-to-SNARK compression that
is incompatible with Railway deployment.

## Endpoints

### `GET /health`
Returns service status and the backend in use.

### `POST /prove`
Takes the policy, payment, and operator-state fields and returns a proof
ready for on-chain verification. Every field below is required except
`stripe_receipt_hash` (zero for the Solana flow):

```json
{
  "max_daily_spend_lamports": 100000000,
  "max_per_transaction_lamports": 10000000,
  "allowed_endpoint_categories": ["compute", "storage"],
  "blocked_addresses": ["4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"],
  "token_whitelist": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  "payment_amount_lamports": 5000000,
  "payment_token_mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payment_recipient": "CBDjvUkZZ6ucrVGrU3vRraasTytha8oVg2NLCxAHE25b",
  "payment_endpoint_category": "compute",
  "policy_id": "9f1c2a4e-5b7d-4c3a-8e2f-1a6b9d0c7e54",
  "operator_id": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "daily_spent_before_lamports": 50000000,
  "current_unix_timestamp": 1759449600
}
```

Response:

```json
{
  "is_compliant": true,
  "journal_digest": "...",
  "groth16": {
    "proof_a": "<base64 64 bytes>",
    "proof_b": "<base64 128 bytes>",
    "proof_c": "<base64 64 bytes>",
    "public_inputs": ["<base64 32 bytes>", "… 10 entries, one per public signal"]
  },
  "raw_proof": { ... },
  "raw_public": ["1", "..."],
  "proving_time_ms": 643
}
```

The `groth16` block is pre-formatted for the `groth16-solana` crate used
by `programs/square-verifier/`. `raw_proof` / `raw_public` are preserved for
off-chain re-verification and debugging.

## Fixed list sizes

Must match the Circom template parameters in
the circuit these artifacts were compiled from (see Artifacts):

| Parameter | Value |
|---|---|
| `MAX_WHITELIST` | 10 |
| `MAX_BLOCKED` | 10 |
| `MAX_CATEGORIES` | 8 |

Input lists longer than these fail with a 500; lists shorter than the
max are padded internally with sentinel zeros and a matching mask bit
so the circuit ignores the unused slots.

## Artifacts

`artifacts/` contains the compiled Circom outputs the service needs at
runtime:

- `payment.wasm` — witness calculator compiled from `payment.circom`
- `payment.zkey` — proving key from the (currently development-only)
  trusted setup ceremony
- `payment_vk.json` — verification key in snarkjs format; the Solana
  verifier's hardcoded `Groth16Verifyingkey` must match this file

These ship inside the Docker image. Replace them with production
ceremony output before mainnet.

## Configuration

Both variables are required; the service refuses to start without them.

| Variable | Description |
|---|---|
| `PROVER_SERVICE_PORT` | HTTP port |
| `CORS_ORIGINS` | Comma-separated allowed origin URLs |

## Local development

```bash
pnpm install
PROVER_SERVICE_PORT=<port> CORS_ORIGINS=<origin> pnpm --filter @squaresdk/solana-prover dev

# In another terminal, against the running service:
PROVER_BASE_URL=http://<host>:<port> node apps/prover/scripts/integration-test.mjs
PROVER_BASE_URL=http://<host>:<port> node apps/prover/scripts/tamper-test.mjs
```

## Regenerate artifacts

The artifacts here were compiled from Aperture's 10-output circuit and match
the verification key in `programs/square-verifier/src/groth16_vk.rs`. The
Square release circuit (`circuits/payment-compliance/`, 13 outputs) has its own
artifact pipeline (BC-20): `circuits/payment-compliance/scripts/release-artifacts.mjs`
produces and checks the release zkey, its verification key and
`programs/square-verifier/src/release_vk.rs`. Moving this service to those
artifacts is BE-11.
