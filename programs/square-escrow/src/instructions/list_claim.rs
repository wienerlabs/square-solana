use anchor_lang::prelude::*;
use square_common::seeds::{CLAIM_SEED, JOB_SEED};

use crate::errors::EscrowError;
use crate::state::{ClaimListing, ClaimStatus, Job, JobStatus, SettlementRail};
use crate::ClaimListed;

#[derive(Accounts)]
pub struct ListClaim<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Seller = `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        constraint = job.agent_wallet == agent.key() @ EscrowError::AgentMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    // Job başına tek listeleme; `cancel_claim` hesabı kapatır, alacak yeniden listelenebilir.
    #[account(
        init,
        payer = payer,
        space = 8 + ClaimListing::INIT_SPACE,
        seeds = [CLAIM_SEED, job.key().as_ref()],
        bump
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ListClaim>, price: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job = &ctx.accounts.job;
    // Fiat işin alacağı escrow'dan ödenmez, satılamaz (ADR 0024).
    require!(
        job.rail == SettlementRail::Escrow,
        EscrowError::RailMismatch
    );
    // Teslim edilmiş, dispute'u olmayan iş; challenge penceresi açık ya da kapanmış olabilir.
    require!(
        job.status == JobStatus::Delivered,
        EscrowError::InvalidStatus
    );
    require!(
        price > 0 && price < job.amount,
        EscrowError::InvalidClaimPrice
    );
    let listing = ClaimListing {
        job: job.key(),
        seller: job.agent_wallet,
        buyer: Pubkey::default(),
        rent_payer: ctx.accounts.payer.key(),
        price,
        face_value: job.amount,
        listed_at: now,
        bought_at: 0,
        status: ClaimStatus::Listed,
        bump: ctx.bumps.claim_listing,
    };
    emit!(ClaimListed {
        job: listing.job,
        seller: listing.seller,
        price,
        face_value: listing.face_value,
    });
    ctx.accounts.claim_listing.set_inner(listing);
    Ok(())
}
