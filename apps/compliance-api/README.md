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
| GET | `/api/v1/compliance/protected-report?operator_id=` | Compliance report behind an x402 v2 payment (see below) |
| GET | `/health` | Liveness (`Health`, API contract) |
| GET | `/ready` | Readiness: the database answers (`Health`; 503 when it does not) |
| GET | `/metrics` | Prometheus metrics, served on the internal-only `COMPLIANCE_METRICS_PORT` |

Logging, metrics, health and alerting come from
[`@squaresdk/solana-observability`](../../packages/observability/) (BE-12). Log lines are JSON; secrets
(Stripe keys, the database password, RPC keys, keypairs) are masked before they are written.

- **Alarms:**
  - `compliance_errors`: more error log lines than `COMPLIANCE_ALERT_ERRORS` within
    `COMPLIANCE_ALERT_ERROR_WINDOW_SECONDS`.
  - `compliance_database_down`: the database check fails for `COMPLIANCE_ALERT_DB_DOWN_SECONDS`.
- **Notifications:** Alarms are logged, and sent to `ALERT_WEBHOOK_URL` when it is set.

## x402 paid report

`/api/v1/compliance/protected-report` is served through
[`@squaresdk/solana-x402`](../../packages/x402/) (BE-24). The service-specific x402 middleware is gone: it
accepted an `x-402-payment` header with the signature of a transaction sent earlier, and it checked neither
the amount, the mint nor the recipient. The same signature could also be reused.

- **No `PAYMENT-SIGNATURE` header:** the answer is 402. The `PAYMENT-REQUIRED` header carries the x402 v2
  requirement:
  - `exact` scheme on `X402_NETWORK` (CAIP-2);
  - `X402_PAYMENT_MINT`, `X402_REPORT_PRICE` base units, paid to `X402_PUBLISHER_WALLET`;
  - the facilitator's fee payer.
- **Payment:** settled before the report is built. The report's `payment.tx_signature` is the settlement
  transaction, and the `PAYMENT-RESPONSE` header is the receipt.
- **`operator_id`:** checked before any payment is asked for.
- **Replay:** a payment payload is accepted once. The record lives in the `replay_guards` table of Square's
  single database (`DATABASE_URL`), so it survives restarts. Expired rows are purged hourly.
- **Facilitator ([ADR 0018](../../docs/decisions/0018-x402-facilitator.md)):**
  - By default it is our own: `X402_FEE_PAYER_KEYPAIR` (SOL only, never the payee) signs as fee payer and
    `SOLANA_RPC_URL` verifies and submits.
  - With `X402_FACILITATOR_URL` (and optionally `X402_FACILITATOR_TOKEN`) a remote x402 facilitator is used.
- **Tests:** `pnpm --filter @squaresdk/solana-compliance-api test` runs them against a fake Solana RPC and a
  Postgres container (Docker required).

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
prices) must be set explicitly. The shared observability variables (`LOG_LEVEL`, `HEALTH_CHECK_TIMEOUT_MS`,
`ALERT_EVALUATION_SECONDS`, `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TIMEOUT_MS`) are described in the
[package README](../../packages/observability/README.md). Optional variables (`STRIPE_WEBHOOK_SECRET`,
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
