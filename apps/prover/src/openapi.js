// Minimal OpenAPI 3.0 spec describing the HTTP surface the prover-service
// exposes. Returned verbatim from GET /api-docs.json so the dashboard's
// API docs page can render it. Kept inline (no codegen) because the API is
// tiny and rarely changes — two endpoints.
export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Aperture Prover Service',
    version: '0.1.0',
    description:
      'Generates Groth16 zero-knowledge proofs for the Aperture payment compliance circuit (Circom + snarkjs). Output is pre-formatted for on-chain verification via groth16-solana.',
  },
  paths: {
    '/health': {
      get: {
        summary: 'Liveness probe',
        tags: ['Meta'],
        responses: {
          '200': {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Health' },
              },
            },
          },
        },
      },
    },
    '/prove': {
      post: {
        summary: 'Generate a payment compliance Groth16 proof',
        tags: ['Proving'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProveRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Proof generated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProveResponse' },
              },
            },
          },
          '500': {
            description: 'Prover error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Health: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'healthy' },
          service: { type: 'string', example: 'aperture-prover-service' },
          version: { type: 'string', example: '0.1.0' },
          backend: { type: 'string', example: 'circom+snarkjs' },
        },
      },
      ProveRequest: {
        type: 'object',
        required: [
          'max_daily_spend_lamports',
          'max_per_transaction_lamports',
          'allowed_endpoint_categories',
          'blocked_addresses',
          'token_whitelist',
          'payment_amount_lamports',
          'payment_token_mint',
          'payment_recipient',
          'payment_endpoint_category',
          'daily_spent_so_far_lamports',
        ],
        properties: {
          max_daily_spend_lamports: { type: 'integer', format: 'int64' },
          max_per_transaction_lamports: { type: 'integer', format: 'int64' },
          allowed_endpoint_categories: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
          },
          blocked_addresses: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
          },
          token_whitelist: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
          },
          payment_amount_lamports: { type: 'integer', format: 'int64' },
          payment_token_mint: { type: 'string' },
          payment_recipient: { type: 'string' },
          payment_endpoint_category: { type: 'string' },
          daily_spent_so_far_lamports: { type: 'integer', format: 'int64' },
        },
      },
      ProveResponse: {
        type: 'object',
        properties: {
          is_compliant: { type: 'boolean' },
          journal_digest: { type: 'string' },
          proving_time_ms: { type: 'integer' },
          groth16: {
            type: 'object',
            properties: {
              proof_a: {
                type: 'string',
                description: '64-byte G1 point, base64 (Y-negated for groth16-solana)',
              },
              proof_b: {
                type: 'string',
                description: '128-byte G2 point, base64 (Fp2 ordering reversed)',
              },
              proof_c: {
                type: 'string',
                description: '64-byte G1 point, base64',
              },
              public_inputs: {
                type: 'array',
                items: { type: 'string', description: '32 bytes, base64' },
              },
            },
          },
          raw_proof: {
            type: 'object',
            description: 'Original snarkjs proof object, preserved for debugging.',
          },
          raw_public: {
            type: 'array',
            items: { type: 'string' },
            description: 'Original snarkjs public signals as decimal strings.',
          },
          amount_range_min: { type: 'integer', format: 'int64' },
          amount_range_max: { type: 'integer', format: 'int64' },
          verification_timestamp: { type: 'string', format: 'date-time' },
          proof_hash: { type: 'string' },
          image_id: { type: 'array', items: { type: 'integer' }, minItems: 8, maxItems: 8 },
          receipt_bytes: { type: 'array', items: { type: 'integer' } },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
      },
    },
  },
};
