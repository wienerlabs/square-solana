# Aperture Payment Prover Circuit

RISC Zero zkVM circuit that proves AI agent payment compliance with operator policies without revealing payment details.

## Structure

```
payment-prover/
├── core/       Shared types and compliance logic (used by both guest and host)
├── methods/    RISC Zero guest program (runs inside zkVM)
└── host/       Host program (runs the prover, produces receipts)
```

## Compliance Checks

The guest program verifies all 5 policy rules inside the zkVM:

1. **Per-transaction limit** - Payment amount <= max_per_transaction_lamports
2. **Daily spending limit** - Accumulated daily + current <= max_daily_spend_lamports
3. **Token whitelist** - Payment token mint is in the allowed list
4. **Blocked addresses** - Recipient is not on the sanctions list
5. **Endpoint categories** - Target endpoint category is permitted

## Build

```bash
cargo build
cargo test -p aperture-payment-prover-core
```

Full proving requires the RISC Zero toolchain:

```bash
cargo install cargo-risczero
cargo risczero install
cargo build --release
```

## Input/Output

**ProverInput**: Policy constraints + payment data + daily accumulator
**ProverOutput**: is_compliant, proof_hash, amount_range (bucketed), journal_digest

Amount ranges use 1 USDC/USDT buckets for privacy preservation.
