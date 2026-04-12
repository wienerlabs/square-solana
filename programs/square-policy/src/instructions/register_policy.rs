use anchor_lang::prelude::*;
use crate::state::{OperatorAccount, PolicyAccount};

#[derive(Accounts)]
#[instruction(policy_id: [u8; 32])]
pub struct RegisterPolicy<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + PolicyAccount::INIT_SPACE,
        seeds = [b"policy", operator_account.key().as_ref(), &policy_id],
        bump,
    )]
    pub policy_account: Account<'info, PolicyAccount>,

    #[account(
        mut,
        seeds = [b"operator", authority.key().as_ref()],
        bump = operator_account.bump,
        has_one = authority,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterPolicy>,
    policy_id: [u8; 32],
    merkle_root: [u8; 32],
    policy_data_hash: [u8; 32],
) -> Result<()> {
    let policy = &mut ctx.accounts.policy_account;
    let operator = &mut ctx.accounts.operator_account;
    let clock = Clock::get()?;

    policy.operator = operator.key();
    policy.policy_id = policy_id;
    policy.merkle_root = merkle_root;
    policy.policy_data_hash = policy_data_hash;
    policy.version = 1;
    policy.active = true;
    policy.created_at = clock.unix_timestamp;
    policy.updated_at = clock.unix_timestamp;
    policy.bump = ctx.bumps.policy_account;

    operator.policy_count = operator.policy_count.checked_add(1).unwrap();

    msg!("Policy registered: version {}", policy.version);
    Ok(())
}
