use anchor_lang::prelude::*;
use square_common::seeds::{CONFIG_SEED, JOB_SEED};

use crate::dispute;
use crate::dispute::VoteOutcome;
use crate::errors::EscrowError;
use crate::state::{DisputeResolution, EscrowConfig, Job, JobStatus};
use crate::{DisputeDecided, DisputeVote, DisputeVoteRejected};

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
    let state: &mut Job = job;
    let outcome = dispute::tally(
        &mut state.dispute,
        &mut state.dispute_rejection_mask,
        config,
        index,
        resolution,
    )?;
    let job_key = job.key();
    match outcome {
        VoteOutcome::Approved { decided } => {
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
        }
        // Bekleyen öneriden farklı oy, öneriye ret sayılır (ADR 0028 madde 4).
        VoteOutcome::Rejected { rejections, reset } => emit!(DisputeVoteRejected {
            job: job_key,
            arbitrator,
            resolution,
            rejection_count: rejections,
            proposal_reset: reset,
        }),
    }
    Ok(())
}
