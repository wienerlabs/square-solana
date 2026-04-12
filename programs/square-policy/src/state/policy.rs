use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct PolicyAccount {
    pub operator: Pubkey,
    pub policy_id: [u8; 32],
    pub merkle_root: [u8; 32],
    pub policy_data_hash: [u8; 32],
    pub version: u32,
    pub active: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub bump: u8,
}
