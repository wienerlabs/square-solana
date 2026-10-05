use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::instructions::agent_job::AgentJob;
use crate::linked;
use crate::state::JobStatus;
use crate::JobAccepted;

pub fn handler(ctx: Context<AgentJob>, spec_hash: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job = &ctx.accounts.job;
    require_keys_eq!(
        ctx.accounts.agent.key(),
        job.agent_wallet,
        EscrowError::AgentMismatch
    );
    match job.status {
        JobStatus::Funded => {}
        JobStatus::Open => return err!(EscrowError::JobNotFunded),
        _ => return err!(EscrowError::InvalidStatus),
    }
    require!(job.spec_hash == spec_hash, EscrowError::SpecHashMismatch);
    require!(now < job.deadline, EscrowError::DeadlineExpired);
    linked::require_active(&linked::bound_agent(&ctx.accounts.agent_record)?)?;

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Accepted;
    emit!(JobAccepted {
        job: job.key(),
        agent_record: job.agent_record,
        agent_wallet: job.agent_wallet,
    });
    Ok(())
}
