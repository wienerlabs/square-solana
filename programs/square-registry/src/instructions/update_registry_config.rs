use anchor_lang::prelude::*;
use square_common::seeds::REGISTRY_CONFIG_SEED;

use crate::errors::RegistryError;
use crate::state::{validate_screening_ttl, RegistryConfig};
use crate::RegistryConfigUpdated;

#[derive(Accounts)]
pub struct UpdateRegistryConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ RegistryError::Unauthorized,
    )]
    pub config: Account<'info, RegistryConfig>,
}

pub fn handler(
    ctx: Context<UpdateRegistryConfig>,
    screener_authority: Pubkey,
    screening_ttl_secs: i64,
) -> Result<()> {
    validate_screening_ttl(screening_ttl_secs)?;
    let config = &mut ctx.accounts.config;
    config.screener_authority = screener_authority;
    config.screening_ttl_secs = screening_ttl_secs;
    emit!(RegistryConfigUpdated {
        admin: config.admin,
        screener_authority,
        screening_ttl_secs,
    });
    Ok(())
}
