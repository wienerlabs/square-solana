# Aperture Compliance API

REST API for managing proof records and batch attestations. Receives individual payment proof records and aggregates them into operator attestations by time period.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/proofs` | Submit a proof record |
| GET | `/api/v1/proofs/:id` | Get proof record by ID |
| GET | `/api/v1/proofs/payment/:paymentId` | Get proof record by payment ID |
| POST | `/api/v1/attestations/batch` | Create batch attestation |
| GET | `/api/v1/attestations/:id` | Get attestation by ID |
| GET | `/api/v1/attestations/operator/:operatorId` | List attestations by operator |
| GET | `/api/v1/attestations/:id/output` | Get attestation in standard output format |
| GET | `/health` | Health check |

## Setup

```bash
# From repo root
pnpm install

# Every variable is listed (empty) in .env.example; src/config.ts validates
# them at boot and refuses to start on a missing or invalid required value.
cp apps/compliance-api/.env.example apps/compliance-api/.env

pnpm --filter @squaresdk/solana-compliance-api migrate
pnpm --filter @squaresdk/solana-compliance-api dev
```

## Environment Variables

See `.env.example` for the full list. No variable has a built-in default:
deployment-specific values (ports, URLs, program/wallet/mint addresses,
prices) must be set explicitly. Optional variables (`STRIPE_WEBHOOK_SECRET`,
`STRIPE_PUBLISHABLE_KEY`, `MPP_AUTHORITY_KEYPAIR_BASE58`, `HELIUS_API_KEY`,
`COMPLIANCE_WATCHER_MINTS`) switch a feature on when present.

## API Documentation

Swagger UI is served at `/api-docs` and the raw document at `/api-docs.json`.

## Batch Attestation Output

```json
{
  "operator_id": "uuid",
  "period_start": "2026-04-01T00:00:00.000Z",
  "period_end": "2026-04-02T00:00:00.000Z",
  "total_payments": 42,
  "total_amount_range": {
    "min": 3500.00,
    "max": 4200.00
  },
  "policy_violations": 0,
  "sanctions_intersections": 0,
  "proof_hash": "sha256-batch-hash"
}
```

The output intentionally uses amount ranges instead of exact values for privacy preservation.
