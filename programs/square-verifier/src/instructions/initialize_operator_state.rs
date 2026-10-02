use anchor_lang::prelude::*;
use crate::state::OperatorState;

/// Allocates the OperatorState PDA for the signing operator. Called once,
/// off the hot path, so the dashboard can show a meaningful "0 USDC spent
/// today" value before the first transfer ever happens. The transfer-hook
/// entry point added in Adım 6 will use `init_if_needed` so that operators
/// who skip this step still get a valid state on their first payment.
///
/// Seeds: ["operator_state", operator]
/// Authority: any signer can pay the rent and trigger init for THEIR OWN
/// operator pubkey — the seed binding makes spoofing impossible.
#[derive(Accounts)]
pub struct InitializeOperatorState<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [b"operator_state", operator.key().as_ref()],
        bump,
    )]
    pub operator_state: Account<'info, OperatorState>,

    pub operator: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeOperatorState>) -> Result<()> {
    let clock = Clock::get()?;
    let state = &mut ctx.accounts.operator_state;

    state.operator = ctx.accounts.operator.key();
    state.daily_spent_lamports = 0;
    state.day_start_unix = OperatorState::day_start_for(clock.unix_timestamp);
    state.total_lifetime_payments = 0;
    state.bump = ctx.bumps.operator_state;

    msg!(
        "OperatorState initialized: operator={}, day_start_unix={}",
        state.operator,
        state.day_start_unix
    );
    Ok(())
}
