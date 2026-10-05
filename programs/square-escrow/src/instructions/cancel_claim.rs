use anchor_lang::prelude::*;
use square_common::seeds::CLAIM_SEED;

use crate::errors::EscrowError;
use crate::state::{ClaimListing, ClaimStatus};
use crate::ClaimCancelled;

#[derive(Accounts)]
pub struct CancelClaim<'info> {
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = rent_payer,
        seeds = [CLAIM_SEED, claim_listing.job.as_ref()],
        bump = claim_listing.bump,
        has_one = seller @ EscrowError::NotClaimSeller,
        has_one = rent_payer @ EscrowError::Unauthorized
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    /// CHECK: receives the listing rent; equals `claim_listing.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CancelClaim>) -> Result<()> {
    let listing = &ctx.accounts.claim_listing;
    // Satılmış alacakta alıcının hakkı zincirdedir; settlement'tan sonra listeleme kaydı olarak kalır.
    require!(
        listing.status == ClaimStatus::Listed,
        EscrowError::InvalidClaimStatus
    );
    emit!(ClaimCancelled { job: listing.job });
    Ok(())
}
