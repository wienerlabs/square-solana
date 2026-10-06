use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use square_common::seeds::{BOND_SEED, CONFIG_SEED, JOB_SEED};

use crate::dispute;
use crate::errors::EscrowError;
use crate::state::{DisputeInfo, EscrowConfig, Job, JobStatus};
use crate::DisputeRaised;

#[derive(Accounts)]
pub struct RaiseDispute<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution @ EscrowError::Unauthorized,
        has_one = mint @ EscrowError::MintMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    // Bond vault'u da job'un kanonik PDA'sıdır, token yetkilisi job; her dispute talimatı aynı adresi türetir.
    // `init_if_needed`: açık bir dispute'un vault'u zaten varsa talimat hata koduyla (DisputeAlreadyActive)
    // reddedilir; vault, mint'i ve yetkilisi (job) denetlenerek yeniden kullanılmaz, işlem geri alınır.
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [BOND_SEED, job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == institution.key() @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RaiseDispute>, reason_hash: [u8; 32], bond: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = &accounts.job;
    let params = &accounts.config.params;
    dispute::require_can_open(job)?;
    // Her işte en fazla bir dispute (program arayüzü §6); lapse olmuş bir dispute da sayılır, kurum
    // aynı teslimi tekrar tekrar itiraz ederek ödemeyi bekletemez (ADR 0016).
    require!(
        job.dispute.raised_at == 0,
        EscrowError::DisputeAlreadyRaised
    );
    require!(now < job.challenge_end, EscrowError::DisputeWindowClosed);
    // Bond sıfır olamaz: bond vault'unun varlığı `dispute.bond > 0`'dan okunur (lapse, execute).
    require!(
        bond > 0 && bond >= dispute::min_bond(job.amount, params)?,
        EscrowError::InsufficientBond
    );

    token_interface::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.institution_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.bond_vault.to_account_info(),
                authority: accounts.institution.to_account_info(),
            },
        ),
        bond,
        accounts.mint.decimals,
    )?;

    let challenger = accounts.institution.key();
    let set_version = accounts.config.arbitrator_set_version;
    let deadline = dispute::deadline(now, params)?;
    let job = &mut ctx.accounts.job;
    job.bond_bump = ctx.bumps.bond_vault;
    job.status = JobStatus::Disputed;
    job.dispute = DisputeInfo {
        challenger,
        bond,
        reason_hash,
        raised_at: now,
        deadline,
        arbitrator_set_version: set_version,
        ..DisputeInfo::default()
    };
    emit!(DisputeRaised {
        job: job.key(),
        challenger,
        bond,
        reason_hash,
        deadline,
    });
    Ok(())
}
