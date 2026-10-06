use anchor_lang::prelude::*;
use square_common::seeds::{CONFIG_SEED, JOB_SEED, SCREENING_SEED};

use crate::errors::EscrowError;
use crate::instructions::create_job::{new_job, NewJob};
use crate::linked;
use crate::state::{EscrowConfig, Job, SettlementRail};
use crate::FiatJobCreated;

#[derive(Accounts)]
#[instruction(spec_hash: [u8; 32])]
pub struct CreateFiatJob<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Institution wallet or its Squads vault; pays the agent off-chain through Stripe.
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    /// CHECK: square_registry `AgentRecord` (owner = `config.registry_program`, status Active).
    pub agent_record: UncheckedAccount<'info>,
    /// CHECK: square_policy `Policy` (owner = `config.policy_program`, active); a fiat job is always
    /// proof-gated and snapshots it.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: square_policy `Institution` of `policy`; `institution` must be its current authority.
    pub policy_institution: UncheckedAccount<'info>,
    /// CHECK: square_registry `ScreeningRecord` of the institution; Clear and not expired.
    #[account(
        seeds = [SCREENING_SEED, institution.key().as_ref()],
        bump,
        seeds::program = config.registry_program.key()
    )]
    pub institution_screening: UncheckedAccount<'info>,
    /// CHECK: square_registry `ScreeningRecord` of the agent record's wallet; Clear and not expired.
    pub agent_screening: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Job::INIT_SPACE,
        seeds = [JOB_SEED, institution.key().as_ref(), spec_hash.as_ref()],
        bump
    )]
    pub job: Box<Account<'info, Job>>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateFiatJob>,
    spec_hash: [u8; 32],
    amount: u64,
    deadline: i64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let job = new_job(
        NewJob {
            institution: accounts.institution.key(),
            agent_record: &accounts.agent_record,
            policy: Some((&accounts.policy, &accounts.policy_institution)),
            config: &accounts.config,
            rent_payer: accounts.payer.key(),
            spec_hash,
            amount,
            deadline,
            rail: SettlementRail::Fiat,
            challenge_period: 0,
            bump: ctx.bumps.job,
            vault_bump: 0,
        },
        now,
    )?;
    // Fonlama adımı yok: `fund_job`'ın iki screening kuralı iş açılırken uygulanır.
    let registry = &accounts.config.registry_program;
    linked::require_clear_screening(
        &accounts.institution_screening,
        registry,
        accounts.institution.key,
        now,
    )?;
    linked::require_clear_screening(&accounts.agent_screening, registry, &job.agent_wallet, now)?;
    let policy = job.policy.ok_or(EscrowError::PolicyMismatch)?;
    emit!(FiatJobCreated {
        job: ctx.accounts.job.key(),
        institution: job.institution,
        agent_record: job.agent_record,
        agent_wallet: job.agent_wallet,
        policy,
        policy_version: job.policy_version,
        mint: job.mint,
        amount,
        spec_hash,
        deadline,
    });
    ctx.accounts.job.set_inner(job);
    Ok(())
}
