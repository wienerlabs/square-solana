use anchor_lang::prelude::*;
use square_common::seeds::{CONFIG_SEED, JOB_SEED, PREFLIGHT_PROOF_SEED};

use crate::errors::EscrowError;
use crate::linked;
use crate::state::{EscrowConfig, Job, JobStatus, SettlementRail};
use crate::JobAccepted;

#[derive(Accounts)]
pub struct AcceptJob<'info> {
    /// Must equal `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = agent_record @ EscrowError::AgentMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_registry `AgentRecord` bound to the job (owner = `config.registry_program`); status
    /// must be Active.
    pub agent_record: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    /// CHECK: square_verifier `PreflightProof` (owner = `config.verifier_program`). Required on a policy
    /// job (ADR 0028): bound to this job and its policy snapshot. Not read on a job without a policy.
    #[account(
        seeds = [PREFLIGHT_PROOF_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.verifier_program.key()
    )]
    pub preflight_proof: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<AcceptJob>, spec_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job = &ctx.accounts.job;
    require_keys_eq!(
        ctx.accounts.agent.key(),
        job.agent_wallet,
        EscrowError::AgentMismatch
    );
    // Escrow işi fonlandıktan sonra, fiat iş (fonlama adımı yok) açıkken kabul edilir.
    match (job.rail, job.status) {
        (SettlementRail::Escrow, JobStatus::Funded) | (SettlementRail::Fiat, JobStatus::Open) => {}
        (SettlementRail::Escrow, JobStatus::Open) => return err!(EscrowError::JobNotFunded),
        _ => return err!(EscrowError::InvalidStatus),
    }
    require!(job.spec_hash == spec_hash, EscrowError::SpecHashMismatch);
    require!(now < job.deadline, EscrowError::DeadlineExpired);
    linked::require_active(&linked::bound_agent(&ctx.accounts.agent_record)?)?;
    // Kurum işin kendi koşullarıyla uyumluluğunu kabulden önce kanıtlamıştır: teslimden sonra kalıcı bir ret
    // çıkamaz (ADR 0028).
    if let Some(policy) = job.policy {
        linked::require_preflight(
            &ctx.accounts.preflight_proof,
            &job.key(),
            &policy,
            &job.policy_commitment,
            &ctx.accounts.config.verifier_program,
        )?;
    }

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Accepted;
    emit!(JobAccepted {
        job: job.key(),
        agent_record: job.agent_record,
        agent_wallet: job.agent_wallet,
    });
    Ok(())
}
