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
npm install

# Copy environment
cp .env.example .env

# Run migrations
npm run migrate

# Start development server
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_HOST` | PostgreSQL host | required |
| `POSTGRES_PORT` | PostgreSQL port | `5432` |
| `POSTGRES_USER` | PostgreSQL user | required |
| `POSTGRES_PASSWORD` | PostgreSQL password | required |
| `POSTGRES_DB` | Database name | required |
| `COMPLIANCE_API_PORT` | Service port | `3002` |
| `POLICY_SERVICE_URL` | Policy Service URL | `http://localhost:3001` |
| `LOG_LEVEL` | Logging level | `info` |

## API Documentation

Swagger UI available at `http://localhost:3002/api-docs`

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
