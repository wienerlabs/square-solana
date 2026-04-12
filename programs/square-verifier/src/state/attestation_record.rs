use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct AttestationRecord {
    pub operator: Pubkey,
    pub batch_hash: [u8; 32],
    pub image_id: [u32; 8],
    pub journal_digest: [u8; 32],
    pub total_payments: u32,
    pub period_start: i64,
    pub period_end: i64,
    pub timestamp: i64,
    pub verified: bool,
    pub bump: u8,
}
