use anchor_lang::prelude::*;
use square_common::seeds::CONFIG_SEED;

use crate::config_rules::validate_params;
use crate::errors::EscrowError;
use crate::state::{EscrowConfig, EscrowParams};
use crate::EscrowConfigUpdated;

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ EscrowError::Unauthorized
    )]
    pub config: Box<Account<'info, EscrowConfig>>,
}

pub fn handler(ctx: Context<UpdateConfig>, params: EscrowParams) -> Result<()> {
    validate_params(&params)?;
    let config = &mut ctx.accounts.config;
    config.params = params;
    emit!(EscrowConfigUpdated {
        admin: config.admin,
        settlement_mint: config.settlement_mint,
        params,
    });
    Ok(())
}
