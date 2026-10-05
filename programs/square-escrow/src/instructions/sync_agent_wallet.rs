use anchor_lang::prelude::*;
use square_common::seeds::JOB_SEED;

use crate::errors::EscrowError;
use crate::linked;
use crate::state::Job;
use crate::JobAgentWalletSynced;

#[derive(Accounts)]
pub struct SyncAgentWallet<'info> {
    /// Must equal `AgentRecord.owner`.
    pub agent_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = agent_record @ EscrowError::AgentMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_registry `AgentRecord` bound to the job; its current `wallet` is copied.
    pub agent_record: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<SyncAgentWallet>) -> Result<()> {
    let record = linked::bound_agent(&ctx.accounts.agent_record)?;
    require_keys_eq!(
        ctx.accounts.agent_owner.key(),
        record.owner,
        EscrowError::Unauthorized
    );
    let job = &mut ctx.accounts.job;
    require!(!job.status.is_settled(), EscrowError::InvalidStatus);
    job.agent_wallet = record.wallet;
    emit!(JobAgentWalletSynced {
        job: job.key(),
        agent_wallet: record.wallet,
    });
    Ok(())
}
