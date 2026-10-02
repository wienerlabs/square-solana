import swaggerJsdoc from 'swagger-jsdoc';
import { config } from './config.js';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Aperture Compliance API',
      version: '0.1.0',
      description: 'Batch attestation service for Aperture ZK compliance layer. Aggregates proof records into operator attestations.',
      contact: {
        name: 'Aperture Team',
      },
    },
    servers: [
      {
        url: `http://localhost:${config.port}`,
        description: 'Local development',
      },
    ],
    components: {
      schemas: {
        ProofRecordInput: {
          type: 'object',
          required: [
            'operator_id', 'policy_id', 'payment_id', 'proof_hash',
            'amount_range_min', 'amount_range_max', 'token_mint', 'is_compliant', 'verified_at',
          ],
          properties: {
            operator_id: { type: 'string', format: 'uuid' },
            policy_id: { type: 'string', format: 'uuid' },
            payment_id: { type: 'string' },
            proof_hash: { type: 'string', minLength: 64, maxLength: 64 },
            amount_range_min: { type: 'number', minimum: 0 },
            amount_range_max: { type: 'number', minimum: 0 },
            token_mint: { type: 'string' },
            is_compliant: { type: 'boolean' },
            verified_at: { type: 'string', format: 'date-time' },
          },
        },
        ProofRecord: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            operator_id: { type: 'string', format: 'uuid' },
            policy_id: { type: 'string', format: 'uuid' },
            payment_id: { type: 'string' },
            proof_hash: { type: 'string' },
            amount_range_min: { type: 'number' },
            amount_range_max: { type: 'number' },
            token_mint: { type: 'string' },
            is_compliant: { type: 'boolean' },
            verified_at: { type: 'string', format: 'date-time' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        BatchAttestationInput: {
          type: 'object',
          required: ['operator_id', 'period_start', 'period_end'],
          properties: {
            operator_id: { type: 'string', format: 'uuid' },
            period_start: { type: 'string', format: 'date-time' },
            period_end: { type: 'string', format: 'date-time' },
          },
        },
        BatchAttestationOutput: {
          type: 'object',
          properties: {
            operator_id: { type: 'string', format: 'uuid' },
            period_start: { type: 'string', format: 'date-time' },
            period_end: { type: 'string', format: 'date-time' },
            total_payments: { type: 'integer' },
            total_amount_range: {
              type: 'object',
              properties: {
                min: { type: 'number' },
                max: { type: 'number' },
              },
            },
            policy_violations: { type: 'integer', example: 0 },
            sanctions_intersections: { type: 'integer', example: 0 },
            proof_hash: { type: 'string' },
          },
        },
        Attestation: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            operator_id: { type: 'string', format: 'uuid' },
            period_start: { type: 'string', format: 'date-time' },
            period_end: { type: 'string', format: 'date-time' },
            total_payments: { type: 'integer' },
            total_amount_range_min: { type: 'number' },
            total_amount_range_max: { type: 'number' },
            policy_violations: { type: 'integer' },
            sanctions_intersections: { type: 'integer' },
            proof_hashes: { type: 'array', items: { type: 'string' } },
            batch_proof_hash: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        ApiError: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            data: { type: 'null' },
            error: { type: 'string' },
            details: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.ts', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
