use anchor_lang::prelude::*;
use crate::state::OperatorAccount;

#[derive(Accounts)]
pub struct InitializeOperator<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + OperatorAccount::INIT_SPACE,
        seeds = [b"operator", authority.key().as_ref()],
        bump,
    )]
    pub operator_account: Account<'info, OperatorAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeOperator>, operator_name: String) -> Result<()> {
    let operator = &mut ctx.accounts.operator_account;
    let clock = Clock::get()?;

    operator.authority = ctx.accounts.authority.key();
    operator.name = operator_name;
    operator.policy_count = 0;
    operator.multisig = None;
    operator.created_at = clock.unix_timestamp;
    operator.bump = ctx.bumps.operator_account;

    msg!("Operator initialized: {}", operator.authority);
    Ok(())
}
