use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use square_common::seeds::{CONFIG_SEED, JOB_SEED, SCREENING_SEED, VAULT_SEED};
use square_common::travel_rule;

use crate::errors::EscrowError;
use crate::linked;
use crate::state::{EscrowConfig, Job, JobStatus};
use crate::JobFunded;

#[derive(Accounts)]
pub struct FundJob<'info> {
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
    #[account(mut, seeds = [VAULT_SEED, job.key().as_ref()], bump = job.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = institution_token_account.mint == mint.key() @ EscrowError::MintMismatch,
        constraint = institution_token_account.owner == institution.key() @ EscrowError::Unauthorized
    )]
    pub institution_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: square_registry `ScreeningRecord` of the institution; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, institution.key().as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub institution_screening: UncheckedAccount<'info>,
    /// CHECK: square_registry `ScreeningRecord` of `job.agent_wallet`; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, job.agent_wallet.as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub agent_screening: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<FundJob>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = &accounts.job;
    require!(job.status == JobStatus::Open, EscrowError::InvalidStatus);
    require!(now < job.deadline, EscrowError::DeadlineExpired);
    // Travel Rule eşiği (ADR 0015): eşik açıksa ve tutar eşiğe eşit ya da üstündeyse önce commitment
    // bağlanır.
    require!(
        !travel_rule::required(job.amount, accounts.config.params.travel_rule_threshold)
            || travel_rule::is_bound(&job.travel_rule_commitment),
        EscrowError::TravelRuleCommitmentRequired
    );
    let registry = &accounts.config.registry_program;
    linked::require_clear_screening(
        &accounts.institution_screening,
        registry,
        accounts.institution.key,
        now,
    )?;
    linked::require_clear_screening(&accounts.agent_screening, registry, &job.agent_wallet, now)?;

    let amount = job.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            accounts.token_program.key(),
            TransferChecked {
                from: accounts.institution_token_account.to_account_info(),
                mint: accounts.mint.to_account_info(),
                to: accounts.vault.to_account_info(),
                authority: accounts.institution.to_account_info(),
            },
        ),
        amount,
        accounts.mint.decimals,
    )?;

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Funded;
    job.funded_at = now;
    emit!(JobFunded {
        job: job.key(),
        amount,
    });
    Ok(())
}
