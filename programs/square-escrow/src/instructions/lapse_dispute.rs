use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use square_common::seeds::{BOND_SEED, CONFIG_SEED, JOB_SEED};

use crate::errors::EscrowError;
use crate::settlement::{self, JobSigner};
use crate::state::{EscrowConfig, Job, JobStatus};
use crate::DisputeLapsed;

#[derive(Accounts)]
pub struct LapseDispute<'info> {
    /// Permissionless caller.
    pub caller: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = mint @ EscrowError::MintMismatch,
        has_one = rent_payer @ EscrowError::Unauthorized
    )]
    pub job: Box<Account<'info, Job>>,
    /// Absent for an escalation without bond.
    #[account(mut, seeds = [BOND_SEED, job.key().as_ref()], bump = job.bond_bump)]
    pub bond_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// Bond refund target (the challenger of a bonded dispute is the institution).
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == job.institution @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: receives the bond vault rent; equals `job.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<LapseDispute>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = &accounts.job;
    require!(
        job.status == JobStatus::Disputed,
        EscrowError::NoActiveDispute
    );
    require!(now >= job.dispute.deadline, EscrowError::DisputeNotExpired);

    // Bond (ve vault'a sonradan gelen fazlası) challenger'a, yani kuruma döner; vault kapanır.
    let mut bond_refunded = 0;
    if job.dispute.bond > 0 {
        let bond_vault = accounts
            .bond_vault
            .as_ref()
            .ok_or(EscrowError::InvalidStatus)?;
        let signer = JobSigner::new(job);
        bond_refunded = bond_vault.amount;
        settlement::transfer(
            &signer,
            &accounts.token_program,
            bond_vault,
            &accounts.mint,
            &accounts.institution_token_account,
            &job.to_account_info(),
            bond_refunded,
        )?;
        settlement::close(
            &signer,
            &accounts.token_program,
            bond_vault,
            &accounts.rent_payer,
            &job.to_account_info(),
        )?;
    }

    // Dispute düşer, iş `Delivered`'a döner ve normal finalize yolundan çözülür (ADR 0016). Kayıt
    // `lapsed` olarak kalır: kurum ikinci bir dispute açamaz.
    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Delivered;
    job.dispute.lapsed = true;
    job.dispute.closed_at = now;
    emit!(DisputeLapsed {
        job: job.key(),
        bond_refunded,
    });
    Ok(())
}
