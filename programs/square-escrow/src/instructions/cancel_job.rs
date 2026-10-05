use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use square_common::seeds::{JOB_SEED, VAULT_SEED};

use crate::errors::EscrowError;
use crate::state::{Job, JobStatus};
use crate::JobCancelled;

#[derive(Accounts)]
pub struct CancelJob<'info> {
    pub institution: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = institution @ EscrowError::Unauthorized,
        has_one = mint @ EscrowError::MintMismatch,
        has_one = rent_payer @ EscrowError::Unauthorized
    )]
    pub job: Box<Account<'info, Job>>,
    // Kanonik vault'a sabit (Covenant guard'ı): sahte bir boş vault geçilip gerçek fon kilitlenemez.
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == institution.key() @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: receives the vault rent; equals `job.rent_payer`.
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<CancelJob>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = &accounts.job;
    match job.status {
        JobStatus::Open | JobStatus::Funded => {}
        JobStatus::Accepted => require!(now > job.deadline, EscrowError::DeadlineNotExpired),
        _ => return err!(EscrowError::InvalidStatus),
    }

    let bump = [job.bump];
    let seeds: &[&[u8]] = &[
        JOB_SEED,
        job.institution.as_ref(),
        job.spec_hash.as_ref(),
        &bump,
    ];
    let signer = &[seeds];
    let refunded_amount = accounts.vault.amount;
    if refunded_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                accounts.token_program.key(),
                TransferChecked {
                    from: accounts.vault.to_account_info(),
                    mint: accounts.mint.to_account_info(),
                    to: accounts.institution_token_account.to_account_info(),
                    authority: job.to_account_info(),
                },
                signer,
            ),
            refunded_amount,
            accounts.mint.decimals,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(
        accounts.token_program.key(),
        CloseAccount {
            account: accounts.vault.to_account_info(),
            destination: accounts.rent_payer.to_account_info(),
            authority: job.to_account_info(),
        },
        signer,
    ))?;

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Cancelled;
    job.settled_at = now;
    emit!(JobCancelled {
        job: job.key(),
        refunded_amount,
    });
    Ok(())
}
