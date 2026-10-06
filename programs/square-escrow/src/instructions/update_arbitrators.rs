use anchor_lang::prelude::*;

use crate::config_rules::arbitrator_slots;
use crate::errors::EscrowError;
use crate::instructions::update_params::UpdateConfig;
use crate::ArbitratorsUpdated;

pub fn handler(ctx: Context<UpdateConfig>, arbitrators: Vec<Pubkey>, threshold: u8) -> Result<()> {
    let slots = arbitrator_slots(&arbitrators, threshold)?;
    let config = &mut ctx.accounts.config;
    config.arbitrators = slots;
    config.arbitrator_count = arbitrators.len() as u8;
    config.threshold = threshold;
    // Aktif dispute'lar sürümü saklar; bir sonraki oy sayımı yeni setle baştan başlatır (ADR 0016).
    config.arbitrator_set_version = config
        .arbitrator_set_version
        .checked_add(1)
        .ok_or(EscrowError::MathOverflow)?;
    emit!(ArbitratorsUpdated {
        arbitrators,
        threshold,
        arbitrator_set_version: config.arbitrator_set_version,
    });
    Ok(())
}
