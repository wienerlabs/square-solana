export interface ProofRecord {
  readonly id: string;
  readonly operator_id: string;
  readonly policy_id: string;
  readonly payment_id: string;
  readonly proof_hash: string;
  readonly amount_range_min: number;
  readonly amount_range_max: number;
  readonly token_mint: string;
  readonly is_compliant: boolean;
  readonly tx_signature: string | null;
  readonly compressed_tx_signature: string | null;
  readonly verified_at: Date;
  readonly created_at: Date;
}

export interface ProofRecordInput {
  readonly operator_id: string;
  readonly policy_id: string;
  readonly payment_id: string;
  readonly proof_hash: string;
  readonly amount_range_min: number;
  readonly amount_range_max: number;
  readonly token_mint: string;
  readonly is_compliant: boolean;
  readonly verified_at: Date;
}

export interface Attestation {
  readonly id: string;
  readonly operator_id: string;
  readonly period_start: Date;
  readonly period_end: Date;
  readonly total_payments: number;
  readonly total_amount_range_min: number;
  readonly total_amount_range_max: number;
  readonly policy_violations: number;
  readonly sanctions_intersections: number;
  readonly proof_hashes: readonly string[];
  readonly batch_proof_hash: string;
  readonly tx_signature: string | null;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed';
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface AttestationInput {
  readonly operator_id: string;
  readonly period_start: Date;
  readonly period_end: Date;
}

export interface BatchAttestationOutput {
  readonly id: string;
  readonly operator_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly total_payments: number;
  readonly total_amount_range: {
    readonly min: number;
    readonly max: number;
  };
  // Always non-negative; in production both currently surface as 0 because
  // the on-chain verifier rejects non-compliant proofs before they ever
  // reach the DB. Typed as `number` so future revisions that persist
  // rejected attempts in a separate table can populate them without a
  // type-system migration.
  readonly policy_violations: number;
  readonly sanctions_intersections: number;
  readonly proof_hash: string;
}
