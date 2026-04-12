use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProofRecord {
    pub operator: Pubkey,
    pub policy_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub image_id: [u32; 8],
    pub journal_digest: [u8; 32],
    pub timestamp: i64,
    pub verified: bool,
    pub bump: u8,
}
