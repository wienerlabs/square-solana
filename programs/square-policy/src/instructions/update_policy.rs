use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    #[account(
        mut,
        seeds = [b"policy", operator_account.key().as_ref(), &policy_account.policy_id],
        bump = policy_account.bump,
        constraint = policy_account.active @ PolicyRegistryError::PolicyInactive,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        seeds = [b"operator", authority.key().as_ref()],
        bump = operator_account.bump,
        has_one = authority,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    pub authority: Signer<'info>,
}

pub fn handler(
    ctx: Context<UpdatePolicy>,
    new_merkle_root: [u8; 32],
    new_policy_data_hash: [u8; 32],
) -> Result<()> {
    let policy = &mut ctx.accounts.policy_account;
    let clock = Clock::get()?;

    policy.merkle_root = new_merkle_root;
    policy.policy_data_hash = new_policy_data_hash;
    policy.version = policy.version.checked_add(1).unwrap();
    policy.updated_at = clock.unix_timestamp;

    msg!("Policy updated to version {}", policy.version);
    Ok(())
}

#[error_code]
pub enum PolicyRegistryError {
    #[msg("Policy is inactive and cannot be updated")]
    PolicyInactive,
}
