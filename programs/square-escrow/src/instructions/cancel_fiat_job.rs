use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::instructions::commit_travel_rule::InstitutionJob;
use crate::state::{JobStatus, SettlementRail};
use crate::JobCancelled;

pub fn handler(ctx: Context<InstitutionJob>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let job = &ctx.accounts.job;
    require!(job.rail == SettlementRail::Fiat, EscrowError::RailMismatch);
    // `cancel_job`'ın kuralları; fiat işte vault ve iade yoktur.
    match job.status {
        JobStatus::Open => {}
        JobStatus::Accepted => require!(now > job.deadline, EscrowError::DeadlineNotExpired),
        _ => return err!(EscrowError::InvalidStatus),
    }

    let job = &mut ctx.accounts.job;
    job.status = JobStatus::Cancelled;
    job.settled_at = now;
    emit!(JobCancelled {
        job: job.key(),
        refunded_amount: 0,
    });
    Ok(())
}
