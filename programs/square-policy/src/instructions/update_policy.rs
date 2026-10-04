use anchor_lang::prelude::*;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};

use crate::errors::PolicyError;
use crate::state::{Institution, Policy};
use crate::PolicyUpdated;

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(
        seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()],
        bump = institution.bump,
        constraint = institution.authority() == authority.key() @ PolicyError::Unauthorized,
    )]
    pub institution: Account<'info, Institution>,
    #[account(
        mut,
        seeds = [POLICY_SEED, institution.key().as_ref(), policy.policy_id.as_ref()],
        bump = policy.bump,
        has_one = institution,
    )]
    pub policy: Account<'info, Policy>,
}

pub fn handler(ctx: Context<UpdatePolicy>, commitment: [u8; 32], daily_ceiling: u64) -> Result<()> {
    require!(daily_ceiling > 0, PolicyError::InvalidDailyCeiling);
    let policy = &mut ctx.accounts.policy;
    require!(policy.active, PolicyError::PolicyInactive);
    policy.commitment = commitment;
    policy.daily_ceiling = daily_ceiling;
    policy.version = policy
        .version
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    policy.updated_at = Clock::get()?.unix_timestamp;
    emit!(PolicyUpdated {
        policy: policy.key(),
        commitment,
        daily_ceiling,
        version: policy.version
    });
    Ok(())
}
