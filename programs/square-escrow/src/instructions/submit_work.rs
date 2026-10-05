use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::instructions::agent_job::AgentJob;
use crate::linked;
use crate::state::{JobStatus, DELIVERY_URI_MAX_LEN};
use crate::WorkSubmitted;

pub fn handler(ctx: Context<AgentJob>, work_hash: [u8; 32], delivery_uri: String) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job = &ctx.accounts.job;
    require_keys_eq!(
        ctx.accounts.agent.key(),
        job.agent_wallet,
        EscrowError::AgentMismatch
    );
    require!(
        job.status == JobStatus::Accepted,
        EscrowError::InvalidStatus
    );
    require!(now < job.deadline, EscrowError::DeadlineExpired);
    require!(
        delivery_uri.len() <= DELIVERY_URI_MAX_LEN,
        EscrowError::DeliveryUriTooLong
    );
    // Kabul edilmiş iş, sonradan `Inactive` olan kayıtla da teslim edilir (program arayüzü §6).
    linked::require_registered(&linked::bound_agent(&ctx.accounts.agent_record)?)?;
    let period = i64::try_from(job.challenge_period).map_err(|_| EscrowError::MathOverflow)?;
    let challenge_end = now.checked_add(period).ok_or(EscrowError::MathOverflow)?;

    let job = &mut ctx.accounts.job;
    job.work_hash = work_hash;
    job.delivered_at = now;
    job.challenge_end = challenge_end;
    job.status = JobStatus::Delivered;
    emit!(WorkSubmitted {
        job: job.key(),
        work_hash,
        delivery_uri: delivery_uri.clone(),
        challenge_end,
    });
    job.delivery_uri = delivery_uri;
    Ok(())
}
