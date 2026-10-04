use anchor_lang::prelude::*;
use square_common::seeds::{REGISTRY_CONFIG_SEED, SCREENING_SEED};

use crate::errors::RegistryError;
use crate::state::{RegistryConfig, ScreeningRecord, ScreeningStatus};
use crate::ScreeningRecorded;

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RecordScreening<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub screener_authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_CONFIG_SEED],
        bump = config.bump,
        has_one = screener_authority @ RegistryError::Unauthorized,
    )]
    pub config: Account<'info, RegistryConfig>,
    // Cüzdan başına tek kayıt; her screening öncekinin üzerine yazar (program arayüzü §5).
    #[account(
        init_if_needed,
        payer = payer,
        space = ScreeningRecord::SPACE,
        seeds = [SCREENING_SEED, wallet.as_ref()],
        bump,
    )]
    pub screening_record: Account<'info, ScreeningRecord>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RecordScreening>,
    wallet: Pubkey,
    status: ScreeningStatus,
    source_hash: [u8; 32],
) -> Result<()> {
    let screened_at = Clock::get()?.unix_timestamp;
    // TTL pozitif (config'te denetlenir); taşma yalnızca i64 sınırına yakın bir TTL'de olur.
    let expires_at = screened_at
        .checked_add(ctx.accounts.config.screening_ttl_secs)
        .ok_or(RegistryError::InvalidScreeningTtl)?;
    let record = &mut ctx.accounts.screening_record;
    record.wallet = wallet;
    record.status = status;
    record.source_hash = source_hash;
    record.screened_at = screened_at;
    record.expires_at = expires_at;
    record.bump = ctx.bumps.screening_record;
    emit!(ScreeningRecorded {
        wallet,
        status,
        source_hash,
        expires_at,
    });
    Ok(())
}
