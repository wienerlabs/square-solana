use anchor_lang::prelude::*;

/// Per-operator compliance status, seeded by ["compliance", operator_key].
/// Updated by verify_mpp_payment_proof. BC-21 replaces this account with
/// `ReleaseProof` (docs/design/program-interface.md).
#[account]
#[derive(InitSpace)]
pub struct ComplianceStatus {
    pub operator: Pubkey,
    pub is_compliant: bool,
    pub last_proof_hash: [u8; 32],
    pub last_verified_at: i64,
    pub total_proofs: u32,
    pub bump: u8,
}
