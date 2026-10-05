use anchor_lang::prelude::*;
use square_common::seeds::VERIFIER_CONFIG_SEED;

use crate::errors::VerifierError;
use crate::state::VerifierConfig;
use crate::{VerifierConfigUpdated, RELEASE_VK_VERSION};

#[derive(Accounts)]
pub struct InitVerifierConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + VerifierConfig::INIT_SPACE,
        seeds = [VERIFIER_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, VerifierConfig>,
    // Programın kendisi; `programdata_address` onu `program_data`'ya bağlar, ikisi de taklit edilemez.
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ VerifierError::Unauthorized
    )]
    pub program: Program<'info, crate::program::SquareVerifier>,
    // Config'i yalnızca yükseltme yetkilisi (Squads vault'u, BC-09) kurar: aksi hâlde yeni bir deploy'da
    // ilk çağıran escrow programını seçip `record_release` ile günlük sayacı yönetebilirdi.
    #[account(
        constraint = program_data.upgrade_authority_address == Some(admin.key())
            @ VerifierError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitVerifierConfig>,
    escrow_program: Pubkey,
    policy_program: Pubkey,
    mpp_authority: Pubkey,
) -> Result<()> {
    let admin = ctx.accounts.admin.key();
    ctx.accounts.config.set_inner(VerifierConfig {
        admin,
        escrow_program,
        policy_program,
        mpp_authority,
        vk_version: RELEASE_VK_VERSION,
        bump: ctx.bumps.config,
    });
    emit!(VerifierConfigUpdated {
        admin,
        escrow_program,
        policy_program,
        mpp_authority,
        vk_version: RELEASE_VK_VERSION,
    });
    Ok(())
}
