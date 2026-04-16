use actix_web::HttpResponse;

const OPENAPI_JSON: &str = r##"{
  "openapi": "3.0.3",
  "info": {
    "title": "Aperture Prover Service API",
    "version": "0.1.0",
    "description": "HTTP server wrapping the RISC Zero zkVM. Accepts a compiled policy + payment context, executes the guest ELF inside the zkVM, and returns a cryptographic STARK receipt (~255 KB) plus the decoded journal output. Real proof generation only; RISC0_DEV_MODE is never set."
  },
  "servers": [
    { "url": "http://localhost:3003", "description": "Local development" }
  ],
  "components": {
    "schemas": {
      "Health": {
        "type": "object",
        "properties": {
          "status": { "type": "string", "example": "healthy" },
          "service": { "type": "string", "example": "aperture-prover-service" },
          "version": { "type": "string", "example": "0.1.0" }
        }
      },
      "ProveRequest": {
        "type": "object",
        "required": [
          "policy_id", "operator_id", "max_daily_spend_lamports", "max_per_transaction_lamports",
          "allowed_endpoint_categories", "blocked_addresses", "token_whitelist",
          "payment_amount_lamports", "payment_token_mint", "payment_recipient",
          "payment_endpoint_category", "payment_timestamp", "daily_spent_so_far_lamports"
        ],
        "properties": {
          "policy_id": { "type": "string", "description": "Policy UUID" },
          "operator_id": { "type": "string", "description": "Solana wallet address (base58) of the operator" },
          "max_daily_spend_lamports": { "type": "integer", "format": "uint64" },
          "max_per_transaction_lamports": { "type": "integer", "format": "uint64" },
          "allowed_endpoint_categories": { "type": "array", "items": { "type": "string" } },
          "blocked_addresses": { "type": "array", "items": { "type": "string" } },
          "token_whitelist": { "type": "array", "items": { "type": "string" } },
          "payment_amount_lamports": { "type": "integer", "format": "uint64" },
          "payment_token_mint": { "type": "string", "description": "SPL Token mint address" },
          "payment_recipient": { "type": "string", "description": "Recipient wallet address" },
          "payment_endpoint_category": { "type": "string", "example": "x402" },
          "payment_timestamp": { "type": "string", "format": "date-time" },
          "daily_spent_so_far_lamports": { "type": "integer", "format": "uint64" }
        }
      },
      "ProveResponse": {
        "type": "object",
        "properties": {
          "is_compliant": { "type": "boolean" },
          "proof_hash": { "type": "string", "description": "SHA-256 digest of the prover output (hex)" },
          "amount_range_min": { "type": "integer", "format": "uint64" },
          "amount_range_max": { "type": "integer", "format": "uint64" },
          "verification_timestamp": { "type": "string", "format": "date-time" },
          "journal_digest": { "type": "string", "description": "Hex-encoded SHA-256 of the RISC Zero journal" },
          "receipt_bytes": {
            "type": "array",
            "items": { "type": "integer", "format": "uint8" },
            "description": "Bincode-serialized RISC Zero receipt (~255 KB STARK proof)"
          },
          "image_id": {
            "type": "array",
            "items": { "type": "integer", "format": "uint32" },
            "minItems": 8,
            "maxItems": 8,
            "description": "RISC Zero guest ELF image identifier (8 u32 words)"
          },
          "proving_time_ms": { "type": "integer", "format": "uint64" }
        }
      },
      "ErrorResponse": {
        "type": "object",
        "properties": {
          "error": { "type": "string" }
        }
      }
    }
  },
  "paths": {
    "/health": {
      "get": {
        "summary": "Service health check",
        "responses": {
          "200": {
            "description": "Healthy",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Health" } } }
          }
        }
      }
    },
    "/prove": {
      "post": {
        "summary": "Generate a RISC Zero ZK proof",
        "description": "Runs the payment-prover guest program inside the zkVM against the supplied policy and payment context. Returns a cryptographic STARK receipt and the decoded public journal. Expect latency in the range of 5-60 seconds (warm cache 5s on ARM64 host, ~45s under amd64 emulation).",
        "requestBody": {
          "required": true,
          "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ProveRequest" } } }
        },
        "responses": {
          "200": {
            "description": "Proof generated and locally verified",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ProveResponse" } } }
          },
          "500": {
            "description": "Proof generation failed",
            "content": { "application/json": { "schema": { "$ref": "#/components/schemas/ErrorResponse" } } }
          }
        }
      }
    }
  }
}"##;

pub async fn openapi_json() -> HttpResponse {
    HttpResponse::Ok()
        .content_type("application/json")
        .body(OPENAPI_JSON)
}
