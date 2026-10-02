use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};

#[derive(Accounts)]
pub struct DeactivatePolicy<'info> {
    #[account(
        mut,
        seeds = [b"policy", operator_account.key().as_ref(), &policy_account.policy_id],
        bump = policy_account.bump,
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

pub fn handler(ctx: Context<DeactivatePolicy>) -> Result<()> {
    let policy = &mut ctx.accounts.policy_account;
    let clock = Clock::get()?;

    policy.active = false;
    policy.updated_at = clock.unix_timestamp;

    msg!("Policy deactivated: version {}", policy.version);
    Ok(())
}
