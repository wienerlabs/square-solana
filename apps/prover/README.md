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
ready for on-chain verification. Request body mirrors the legacy service:

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
  "daily_spent_so_far_lamports": 50000000
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
    "public_inputs": ["<base64 32 bytes>", "<base64 32 bytes>"]
  },
  "raw_proof": { ... },
  "raw_public": ["1", "..."],
  "proving_time_ms": 643
}
```

The `groth16` block is pre-formatted for the `groth16-solana` crate used
by `programs/verifier/`. `raw_proof` / `raw_public` are preserved for
off-chain re-verification and debugging.

## Fixed list sizes

Must match the Circom template parameters in
`circuits/payment-prover/payment.circom`:

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

## Local development

```bash
cd services/prover-service
npm install
PROVER_SERVICE_PORT=3003 npm run dev

# In another terminal:
curl http://localhost:3003/health
```

## Regenerate artifacts

When `payment.circom` changes, rebuild the artifacts from the circuit
directory and copy them here:

```bash
cd circuits/payment-prover
# (follow the README there to recompile + rerun ceremony)
cp build/payment_js/payment.wasm      ../../services/prover-service/artifacts/
cp build/payment_final.zkey           ../../services/prover-service/artifacts/payment.zkey
cp build/payment_vk.json              ../../services/prover-service/artifacts/
```

The Solana verifier's verification key must be updated in lockstep —
extract from `payment_vk.json` into
`programs/verifier/src/groth16_vk.rs`.
