use anchor_lang::prelude::*;
use square_common::seeds::REGISTRY_CONFIG_SEED;

use crate::errors::RegistryError;
use crate::state::{validate_screening_ttl, RegistryConfig};
use crate::RegistryConfigUpdated;

#[derive(Accounts)]
pub struct InitRegistryConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = RegistryConfig::SPACE,
        seeds = [REGISTRY_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, RegistryConfig>,
    // Programın kendisi; `programdata_address` onu aşağıdaki `program_data`'ya bağlar, ikisi de taklit
    // edilemez.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ RegistryError::Unauthorized,
    )]
    pub program: Program<'info, crate::program::SquareRegistry>,
    // Config'i yalnızca yükseltme yetkilisi (Squads vault'u, BC-09) kurar. Aksi halde yeni bir deploy'da
    // ilk çağıran `admin` ve `screener_authority`'yi ele geçirirdi.
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ RegistryError::Unauthorized,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitRegistryConfig>,
    screener_authority: Pubkey,
    screening_ttl_secs: i64,
) -> Result<()> {
    validate_screening_ttl(screening_ttl_secs)?;
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.screener_authority = screener_authority;
    config.screening_ttl_secs = screening_ttl_secs;
    config.bump = ctx.bumps.config;
    emit!(RegistryConfigUpdated {
        admin: config.admin,
        screener_authority,
        screening_ttl_secs,
    });
    Ok(())
}
