use anchor_lang::prelude::*;
use square_common::seeds::{CONFIG_SEED, JOB_SEED};

use crate::dispute;
use crate::errors::EscrowError;
use crate::state::{DisputeResolution, EscrowConfig, Job, JobStatus};
use crate::{DisputeDecided, DisputeVote};

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// One of `config.arbitrators[..arbitrator_count]`.
    pub arbitrator: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, EscrowConfig>>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump
    )]
    pub job: Box<Account<'info, Job>>,
}

pub fn handler(ctx: Context<ResolveDispute>, resolution: DisputeResolution) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &ctx.accounts.config;
    let arbitrator = ctx.accounts.arbitrator.key();
    let job = &mut ctx.accounts.job;
    require!(
        job.status == JobStatus::Disputed,
        EscrowError::NoActiveDispute
    );
    // Son tarihten sonra oy yok: dispute yalnızca `lapse_dispute` ile düşer (ADR 0016).
    require!(now < job.dispute.deadline, EscrowError::DisputeWindowClosed);
    let index = dispute::arbitrator_index(config, &arbitrator)?;
    dispute::validate_vote(&resolution, job.amount)?;
    let decided = dispute::tally(&mut job.dispute, config, index, resolution)?;
    let job_key = job.key();
    emit!(DisputeVote {
        job: job_key,
        arbitrator,
        resolution,
        approval_count: job.dispute.approval_count,
    });
    if decided {
        job.status = JobStatus::Resolved;
        job.dispute.decided_at = now;
        emit!(DisputeDecided {
            job: job_key,
            resolution,
        });
    }
    Ok(())
}
