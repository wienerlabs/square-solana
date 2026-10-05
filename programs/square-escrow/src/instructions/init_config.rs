use anchor_lang::prelude::*;
use square_common::seeds::CONFIG_SEED;

use crate::config_rules::{arbitrator_slots, validate_params};
use crate::errors::EscrowError;
use crate::state::{EscrowConfig, EscrowParams, LinkedPrograms};
use crate::EscrowConfigUpdated;

#[derive(Accounts)]
pub struct InitConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + EscrowConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, EscrowConfig>>,
    // Programın kendisi; `programdata_address` onu `program_data`'ya bağlar, ikisi de taklit edilemez.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ EscrowError::Unauthorized
    )]
    pub program: Program<'info, crate::program::SquareEscrow>,
    // Config'i yalnızca yükseltme yetkilisi (Squads vault'u, BC-09) kurar (Covenant guard'ı): aksi
    // hâlde yeni bir deploy'da ilk çağıran `admin`'i ve arbitrator setini ele geçirirdi.
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ EscrowError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitConfig>,
    settlement_mint: Pubkey,
    arbitrators: Vec<Pubkey>,
    threshold: u8,
    params: EscrowParams,
    linked: LinkedPrograms,
) -> Result<()> {
    validate_params(&params)?;
    let slots = arbitrator_slots(&arbitrators, threshold)?;
    let admin = ctx.accounts.admin.key();
    ctx.accounts.config.set_inner(EscrowConfig {
        admin,
        settlement_mint,
        registry_program: linked.registry_program,
        policy_program: linked.policy_program,
        verifier_program: linked.verifier_program,
        arbitrators: slots,
        arbitrator_count: arbitrators.len() as u8,
        threshold,
        arbitrator_set_version: 0,
        params,
        bump: ctx.bumps.config,
    });
    emit!(EscrowConfigUpdated {
        admin,
        settlement_mint,
        params,
    });
    Ok(())
}
