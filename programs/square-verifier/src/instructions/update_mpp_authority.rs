use anchor_lang::prelude::*;
use square_common::seeds::VERIFIER_CONFIG_SEED;

use crate::errors::VerifierError;
use crate::state::VerifierConfig;
use crate::VerifierConfigUpdated;

#[derive(Accounts)]
pub struct UpdateMppAuthority<'info> {
    /// `config.admin` (the Squads vault on deployed clusters).
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [VERIFIER_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ VerifierError::Unauthorized
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(ctx: Context<UpdateMppAuthority>, mpp_authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.mpp_authority = mpp_authority;
    emit!(VerifierConfigUpdated {
        admin: config.admin,
        escrow_program: config.escrow_program,
        policy_program: config.policy_program,
        mpp_authority,
        vk_version: config.vk_version,
    });
    Ok(())
}
