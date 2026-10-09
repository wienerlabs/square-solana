use anchor_lang::prelude::*;
use square_common::seeds::JOB_SEED;

use crate::errors::EscrowError;
use crate::state::Job;

/// `submit_work`'ün hesapları: imzacı job'un agent cüzdanı, kayıt job'a bağlı olanı. `accept_job` ayrıca
/// config'i ve ön-ispatı okur (`AcceptJob`).
#[derive(Accounts)]
pub struct AgentJob<'info> {
    /// Must equal `job.agent_wallet`.
    pub agent: Signer<'info>,
    #[account(
        mut,
        seeds = [JOB_SEED, job.institution.as_ref(), job.spec_hash.as_ref()],
        bump = job.bump,
        has_one = agent_record @ EscrowError::AgentMismatch
    )]
    pub job: Box<Account<'info, Job>>,
    /// CHECK: square_registry `AgentRecord` bound to the job (owner = `config.registry_program`);
    /// `accept_job` requires status Active.
    pub agent_record: UncheckedAccount<'info>,
}
