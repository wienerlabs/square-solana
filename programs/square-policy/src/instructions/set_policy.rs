use anchor_lang::prelude::*;
use square_common::seeds::{INSTITUTION_SEED, POLICY_SEED};

use crate::errors::PolicyError;
use crate::state::{Institution, Policy};
use crate::PolicyCommitted;

#[derive(Accounts)]
#[instruction(policy_id: [u8; 32])]
pub struct SetPolicy<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// `owner_key` while no multisig is bound, afterwards only `multisig_vault`.
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [INSTITUTION_SEED, institution.owner_key.as_ref()],
        bump = institution.bump,
        constraint = institution.authority() == authority.key() @ PolicyError::Unauthorized,
    )]
    pub institution: Account<'info, Institution>,
    #[account(
        init,
        payer = payer,
        space = Policy::SPACE,
        seeds = [POLICY_SEED, institution.key().as_ref(), &policy_id],
        bump,
    )]
    pub policy: Account<'info, Policy>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<SetPolicy>,
    policy_id: [u8; 32],
    commitment: [u8; 32],
    daily_ceiling: u64,
) -> Result<()> {
    require!(daily_ceiling > 0, PolicyError::InvalidDailyCeiling);
    let now = Clock::get()?.unix_timestamp;
    let institution = &mut ctx.accounts.institution;
    institution.policy_count = institution
        .policy_count
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    let policy = &mut ctx.accounts.policy;
    policy.institution = institution.key();
    policy.policy_id = policy_id;
    policy.commitment = commitment;
    policy.daily_ceiling = daily_ceiling;
    policy.buyer_root = [0; 32];
    policy.version = 1;
    policy.active = true;
    policy.created_at = now;
    policy.updated_at = now;
    policy.bump = ctx.bumps.policy;
    emit!(PolicyCommitted {
        policy: policy.key(),
        institution: policy.institution,
        policy_id,
        commitment,
        daily_ceiling,
        version: policy.version,
    });
    Ok(())
}
