use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct OperatorAccount {
    pub authority: Pubkey,
    #[max_len(64)]
    pub name: String,
    pub policy_count: u32,
    pub multisig: Option<Pubkey>,
    pub created_at: i64,
    pub bump: u8,
}
