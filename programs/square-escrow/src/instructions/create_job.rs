use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use square_common::seeds::{CONFIG_SEED, JOB_SEED, VAULT_SEED};

use crate::errors::EscrowError;
use crate::linked::{self, PolicySnapshot};
use crate::state::{DisputeInfo, EscrowConfig, Job, JobStatus};
use crate::JobCreated;

#[derive(Accounts)]
#[instruction(spec_hash: [u8; 32])]
pub struct CreateJob<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Institution wallet or its Squads vault; funds the job and receives refunds.
    pub institution: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    /// CHECK: square_registry `AgentRecord` (owner = `config.registry_program`, status Active).
    pub agent_record: UncheckedAccount<'info>,
    /// CHECK: optional square_policy `Policy` (owner = `config.policy_program`, active); makes the
    /// job proof-gated and is snapshotted into the job.
    pub policy: Option<UncheckedAccount<'info>>,
    /// CHECK: square_policy `Institution` of `policy`; `institution` must be its current authority.
    pub policy_institution: Option<UncheckedAccount<'info>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Job::INIT_SPACE,
        seeds = [JOB_SEED, institution.key().as_ref(), spec_hash.as_ref()],
        bump
    )]
    pub job: Box<Account<'info, Job>>,
    // Vault, job'un kanonik PDA'sı ve token yetkilisi job'dur; her talimat aynı adresi türetir.
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, job.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = job,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    // Tek settlement mint'i (program arayüzü §8, açık nokta 11).
    #[account(address = config.settlement_mint @ EscrowError::MintMismatch)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateJob>,
    spec_hash: [u8; 32],
    amount: u64,
    deadline: i64,
    challenge_period: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let accounts = &ctx.accounts;
    let params = &accounts.config.params;
    require!(amount > 0, EscrowError::InvalidAmount);
    require!(deadline > now, EscrowError::DeadlineExpired);
    require!(
        challenge_period >= params.min_challenge_period
            && challenge_period <= params.max_challenge_period,
        EscrowError::InvalidChallengePeriod
    );

    let record =
        linked::registered_agent(&accounts.agent_record, &accounts.config.registry_program)?;
    linked::require_active(&record)?;
    let snapshot = match (&accounts.policy, &accounts.policy_institution) {
        (Some(policy), Some(institution)) => Some(linked::policy_snapshot(
            policy,
            institution,
            accounts.institution.key,
            &accounts.config.policy_program,
        )?),
        (None, None) => None,
        _ => return err!(EscrowError::PolicyMismatch),
    };

    let institution = accounts.institution.key();
    let agent_record = accounts.agent_record.key();
    let mint = accounts.mint.key();
    let job = Job {
        institution,
        agent_record,
        agent_wallet: record.wallet,
        mint,
        rent_payer: accounts.payer.key(),
        amount,
        spec_hash,
        status: JobStatus::Open,
        created_at: now,
        funded_at: 0,
        deadline,
        challenge_period,
        challenge_end: 0,
        delivered_at: 0,
        settled_at: 0,
        work_hash: [0; 32],
        travel_rule_commitment: [0; 32],
        policy_commitment: snapshot.as_ref().map_or([0; 32], |s| s.commitment),
        policy_daily_ceiling: snapshot.as_ref().map_or(0, |s| s.daily_ceiling),
        policy_version: snapshot.as_ref().map_or(0, |s| s.version),
        bump: ctx.bumps.job,
        vault_bump: ctx.bumps.vault,
        bond_bump: 0,
        policy: snapshot.as_ref().map(|s: &PolicySnapshot| s.policy),
        dispute: DisputeInfo::default(),
        delivery_uri: String::new(),
    };
    emit!(JobCreated {
        job: ctx.accounts.job.key(),
        institution,
        agent_record,
        agent_wallet: job.agent_wallet,
        policy: job.policy,
        policy_version: job.policy_version,
        mint,
        amount,
        spec_hash,
        deadline,
        challenge_period,
    });
    ctx.accounts.job.set_inner(job);
    Ok(())
}
