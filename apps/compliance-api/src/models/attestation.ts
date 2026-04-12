import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import { computeBatchHash } from '../utils/crypto.js';
import type { Attestation, BatchAttestationOutput, ProofRecord } from '@aperture/types';

interface AttestationRow {
  id: string;
  operator_id: string;
  period_start: Date;
  period_end: Date;
  total_payments: number;
  total_amount_range_min: string;
  total_amount_range_max: string;
  policy_violations: number;
  sanctions_intersections: number;
  proof_hashes: string[];
  batch_proof_hash: string;
  tx_signature: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function rowToAttestation(row: AttestationRow): Attestation {
  return {
    id: row.id,
    operator_id: row.operator_id,
    period_start: row.period_start,
    period_end: row.period_end,
    total_payments: row.total_payments,
    total_amount_range_min: parseFloat(row.total_amount_range_min),
    total_amount_range_max: parseFloat(row.total_amount_range_max),
    policy_violations: row.policy_violations,
    sanctions_intersections: row.sanctions_intersections,
    proof_hashes: row.proof_hashes,
    batch_proof_hash: row.batch_proof_hash,
    tx_signature: row.tx_signature ?? null,
    status: row.status as Attestation['status'],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function createBatchAttestation(
  operatorId: string,
  periodStart: Date,
  periodEnd: Date,
  proofRecords: readonly ProofRecord[]
): Promise<Attestation> {
  return transaction(async (client) => {
    const id = uuidv4();

    const compliantRecords = proofRecords.filter((r) => r.is_compliant);
    const violations = proofRecords.filter((r) => !r.is_compliant).length;

    const totalAmountMin = compliantRecords.reduce((sum, r) => sum + r.amount_range_min, 0);
    const totalAmountMax = compliantRecords.reduce((sum, r) => sum + r.amount_range_max, 0);
    const proofHashes = proofRecords.map((r) => r.proof_hash);
    const batchHash = computeBatchHash(proofHashes);

    const result = await client.query<AttestationRow>(
      `INSERT INTO attestations (id, operator_id, period_start, period_end, total_payments,
         total_amount_range_min, total_amount_range_max, policy_violations, sanctions_intersections,
         proof_hashes, batch_proof_hash, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'completed')
       RETURNING *`,
      [
        id,
        operatorId,
        periodStart,
        periodEnd,
        proofRecords.length,
        totalAmountMin,
        totalAmountMax,
        violations,
        0,
        proofHashes,
        batchHash,
      ]
    );

    logger.info('Batch attestation created', {
      attestation_id: id,
      operator_id: operatorId,
      total_payments: proofRecords.length,
      violations,
    });

    return rowToAttestation(result.rows[0]);
  });
}

export async function getAttestationById(id: string): Promise<Attestation | null> {
  const result = await query<AttestationRow>(
    'SELECT * FROM attestations WHERE id = $1',
    [id]
  );
  return result.rows.length > 0 ? rowToAttestation(result.rows[0]) : null;
}

export async function getAttestationsByOperator(
  operatorId: string,
  page: number,
  limit: number
): Promise<{ attestations: Attestation[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM attestations WHERE operator_id = $1',
    [operatorId]
  );

  const result = await query<AttestationRow>(
    `SELECT * FROM attestations WHERE operator_id = $1
     ORDER BY period_end DESC LIMIT $2 OFFSET $3`,
    [operatorId, limit, offset]
  );

  return {
    attestations: result.rows.map(rowToAttestation),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

export async function updateTxSignature(
  id: string,
  txSignature: string
): Promise<Attestation | null> {
  const result = await query<AttestationRow>(
    `UPDATE attestations SET tx_signature = $1, updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [txSignature, id]
  );
  if (result.rows.length === 0) return null;

  logger.info('Attestation tx_signature updated', {
    attestation_id: id,
    tx_signature: txSignature,
  });
  return rowToAttestation(result.rows[0]);
}

export function formatBatchOutput(attestation: Attestation): BatchAttestationOutput {
  return {
    id: attestation.id,
    operator_id: attestation.operator_id,
    period_start: attestation.period_start.toISOString(),
    period_end: attestation.period_end.toISOString(),
    total_payments: attestation.total_payments,
    total_amount_range: {
      min: attestation.total_amount_range_min,
      max: attestation.total_amount_range_max,
    },
    policy_violations: 0,
    sanctions_intersections: 0,
    proof_hash: attestation.batch_proof_hash,
  };
}
