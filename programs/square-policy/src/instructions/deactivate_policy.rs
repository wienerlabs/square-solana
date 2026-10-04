use anchor_lang::prelude::*;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};

use crate::errors::PolicyError;
use crate::state::{Institution, Policy};
use crate::PolicyDeactivated;

#[derive(Accounts)]
pub struct DeactivatePolicy<'info> {
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

pub fn handler(ctx: Context<DeactivatePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    require!(policy.active, PolicyError::PolicyInactive);
    policy.active = false;
    policy.updated_at = Clock::get()?.unix_timestamp;
    emit!(PolicyDeactivated {
        policy: policy.key()
    });
    Ok(())
}
