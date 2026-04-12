import { v4 as uuidv4 } from 'uuid';
import { query } from '../utils/database.js';
import { logger } from '../utils/logger.js';
import type { ProofRecord, ProofRecordInput } from '@aperture/types';

interface ProofRecordRow {
  id: string;
  operator_id: string;
  policy_id: string;
  payment_id: string;
  proof_hash: string;
  amount_range_min: string;
  amount_range_max: string;
  token_mint: string;
  is_compliant: boolean;
  tx_signature: string | null;
  verified_at: Date;
  created_at: Date;
}

function rowToProofRecord(row: ProofRecordRow): ProofRecord {
  return {
    id: row.id,
    operator_id: row.operator_id,
    policy_id: row.policy_id,
    payment_id: row.payment_id,
    proof_hash: row.proof_hash,
    amount_range_min: parseFloat(row.amount_range_min),
    amount_range_max: parseFloat(row.amount_range_max),
    token_mint: row.token_mint,
    is_compliant: row.is_compliant,
    tx_signature: row.tx_signature ?? null,
    verified_at: row.verified_at,
    created_at: row.created_at,
  };
}

export async function createProofRecord(input: ProofRecordInput): Promise<ProofRecord> {
  const id = uuidv4();
  const result = await query<ProofRecordRow>(
    `INSERT INTO proof_records (id, operator_id, policy_id, payment_id, proof_hash,
       amount_range_min, amount_range_max, token_mint, is_compliant, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id,
      input.operator_id,
      input.policy_id,
      input.payment_id,
      input.proof_hash,
      input.amount_range_min,
      input.amount_range_max,
      input.token_mint,
      input.is_compliant,
      input.verified_at,
    ]
  );

  logger.info('Proof record created', {
    proof_id: id,
    operator_id: input.operator_id,
    payment_id: input.payment_id,
  });
  return rowToProofRecord(result.rows[0]);
}

export async function getProofRecordsByOperatorAndPeriod(
  operatorId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<ProofRecord[]> {
  const result = await query<ProofRecordRow>(
    `SELECT * FROM proof_records
     WHERE operator_id = $1 AND verified_at >= $2 AND verified_at < $3
     ORDER BY verified_at ASC`,
    [operatorId, periodStart, periodEnd]
  );
  return result.rows.map(rowToProofRecord);
}

export async function getProofRecordById(id: string): Promise<ProofRecord | null> {
  const result = await query<ProofRecordRow>(
    'SELECT * FROM proof_records WHERE id = $1',
    [id]
  );
  return result.rows.length > 0 ? rowToProofRecord(result.rows[0]) : null;
}

export async function getProofRecordsByOperator(
  operatorId: string,
  page: number,
  limit: number
): Promise<{ records: ProofRecord[]; total: number }> {
  const offset = (page - 1) * limit;
  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM proof_records WHERE operator_id = $1',
    [operatorId]
  );
  const result = await query<ProofRecordRow>(
    'SELECT * FROM proof_records WHERE operator_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
    [operatorId, limit, offset]
  );
  return {
    records: result.rows.map(rowToProofRecord),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

export async function updateProofTxSignature(
  id: string,
  txSignature: string
): Promise<ProofRecord | null> {
  const result = await query<ProofRecordRow>(
    'UPDATE proof_records SET tx_signature = $1 WHERE id = $2 RETURNING *',
    [txSignature, id]
  );
  if (result.rows.length === 0) return null;
  logger.info('Proof tx_signature updated', { proof_id: id, tx_signature: txSignature });
  return rowToProofRecord(result.rows[0]);
}

export async function getProofRecordByPaymentId(paymentId: string): Promise<ProofRecord | null> {
  const result = await query<ProofRecordRow>(
    'SELECT * FROM proof_records WHERE payment_id = $1',
    [paymentId]
  );
  return result.rows.length > 0 ? rowToProofRecord(result.rows[0]) : null;
}
