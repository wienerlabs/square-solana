use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use square_common::merkle;
use square_common::seeds::{CLAIM_SEED, CONFIG_SEED, JOB_SEED, SCREENING_SEED};

use crate::errors::EscrowError;
use crate::linked;
use crate::state::{ClaimListing, ClaimStatus, EscrowConfig, Job, JobStatus};
use crate::ClaimBought;

#[derive(Accounts)]
pub struct BuyClaim<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = mint @ EscrowError::MintMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    #[account(
        mut,
        seeds = [CLAIM_SEED, job.key().as_ref()],
        bump = claim_listing.bump,
        has_one = job @ EscrowError::ClaimListingMismatch
    )]
    pub claim_listing: Box<Account<'info, ClaimListing>>,
    /// CHECK: square_policy `Policy` equal to `job.policy`; its current `buyer_root` is read.
    /// Omitted for jobs without a policy.
    pub policy: Option<UncheckedAccount<'info>>,
    /// CHECK: square_registry `ScreeningRecord` of the buyer; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, buyer.key().as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub buyer_screening: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = buyer)]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = claim_listing.seller)]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Listelemenin satılabilir olması ve fiyatın beklenen fiyat olması.
fn require_buyable(accounts: &BuyClaim, price: u64) -> Result<()> {
    let job = &accounts.job;
    let listing = &accounts.claim_listing;
    require!(
        job.status == JobStatus::Delivered,
        EscrowError::InvalidStatus
    );
    require!(
        listing.status == ClaimStatus::Listed,
        EscrowError::InvalidClaimStatus
    );
    // Agent cüzdanı `sync_agent_wallet` ile değiştiyse eski cüzdanın listelemesi satılamaz: fiyat, job'un
    // artık tanımadığı cüzdana giderdi.
    require_keys_eq!(
        listing.seller,
        job.agent_wallet,
        EscrowError::InvalidClaimStatus
    );
    require!(price == listing.price, EscrowError::ClaimPriceChanged);
    Ok(())
}

/// Alıcı satıcı ya da işi fonlayan kurum olamaz, kurumun onaylı listesinde olmalı ve screening'i temiz
/// ve taze olmalı.
fn require_eligible_buyer(
    accounts: &BuyClaim,
    leaf_salt: &[u8; 32],
    merkle_proof: &[[u8; 32]],
    now: i64,
) -> Result<()> {
    let job = &accounts.job;
    let buyer = accounts.buyer.key();
    require_keys_neq!(
        buyer,
        accounts.claim_listing.seller,
        EscrowError::BuyerIsSeller
    );
    // Kurum kendi işinin alacağını alırsa escrow'u kendine yönlendirir ve dispute'la agent'ı
    // sıkıştırabilir (Covenant'ın kuralı).
    require_keys_neq!(buyer, job.institution, EscrowError::Unauthorized);
    let root = linked::buyer_root(
        accounts.policy.as_ref().map(|policy| policy.as_ref()),
        job.policy,
        &accounts.config.policy_program,
    )?;
    require!(
        merkle::verify_buyer_proof(&root, &buyer, leaf_salt, merkle_proof),
        EscrowError::BuyerNotEligible
    );
    linked::require_clear_screening(
        &accounts.buyer_screening,
        &accounts.config.registry_program,
        &buyer,
        now,
    )
}

pub fn handler(
    ctx: Context<BuyClaim>,
    price: u64,
    leaf_salt: [u8; 32],
    merkle_proof: Vec<[u8; 32]>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    require_buyable(accounts, price)?;
    require_eligible_buyer(accounts, &leaf_salt, &merkle_proof, now)?;

    // Fiyat alıcıdan satıcıya şimdi gider; release'te escrow'un neti alıcıya ödenir.
    token_interface::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.buyer_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.seller_token_account.to_account_info(),
                authority: accounts.buyer.to_account_info(),
            },
        ),
        price,
        accounts.mint.decimals,
    )?;

    let buyer = accounts.buyer.key();
    let bought = ClaimListing {
        buyer,
        bought_at: now,
        status: ClaimStatus::Bought,
        ..(**accounts.claim_listing).clone()
    };
    emit!(ClaimBought {
        job: bought.job,
        buyer,
        price,
    });
    ctx.accounts.claim_listing.set_inner(bought);
    Ok(())
}
