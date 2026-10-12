use anchor_lang::prelude::*;
use square_common::seeds::VERIFIER_CONFIG_SEED;

use crate::errors::VerifierError;
use crate::state::VerifierConfig;
use crate::{VerifierConfigUpdated, RELEASE_VK_VERSION};

#[derive(Accounts)]
pub struct SyncVkVersion<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [VERIFIER_CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ VerifierError::Unauthorized
    )]
    pub config: Account<'info, VerifierConfig>,
}

pub fn handler(ctx: Context<SyncVkVersion>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    // Yalnızca upgrade'den sonra anlamlıdır. Aynı sürümde başarılı bir çağrı, yeni kodun henüz çalışmadığını
    // (upgrade yürütülmediğini ya da eski programın çağrıldığını) gizlerdi.
    require!(
        config.vk_version != RELEASE_VK_VERSION,
        VerifierError::VkVersionAlreadySynced
    );
    config.vk_version = RELEASE_VK_VERSION;
    emit!(VerifierConfigUpdated {
        admin: config.admin,
        escrow_program: config.escrow_program,
        policy_program: config.policy_program,
        mpp_authority: config.mpp_authority,
        vk_version: RELEASE_VK_VERSION,
    });
    Ok(())
}
