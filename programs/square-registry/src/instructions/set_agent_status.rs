use anchor_lang::prelude::*;
use square_common::seeds::AGENT_SEED;

use crate::errors::RegistryError;
use crate::state::{AgentRecord, AgentStatus};
use crate::AgentStatusChanged;

#[derive(Accounts)]
pub struct SetAgentStatus<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.creator.as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

pub fn handler(ctx: Context<SetAgentStatus>, status: AgentStatus) -> Result<()> {
    // `Deregistered` yalnızca `deregister_agent` ile, geri dönüşsüz (profil §4.2/3).
    require!(
        status != AgentStatus::Deregistered,
        RegistryError::InvalidAgentStatus
    );
    let record = &mut ctx.accounts.agent_record;
    record.require_registered()?;
    record.status = status;
    record.updated_at = Clock::get()?.unix_timestamp;
    emit!(AgentStatusChanged {
        agent_record: record.key(),
        status,
    });
    Ok(())
}
