use anchor_lang::prelude::*;
use square_common::seeds::AGENT_SEED;

use crate::errors::RegistryError;
use crate::state::{AgentRecord, AgentStatus};
use crate::AgentDeregistered;

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.creator.as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

pub fn handler(ctx: Context<DeregisterAgent>) -> Result<()> {
    let record = &mut ctx.accounts.agent_record;
    record.require_registered()?;
    // Hesap kapatılmaz: aynı (creator, agent_id) yeniden kaydedilip itibarı ve did:aip'i devralamaz.
    record.status = AgentStatus::Deregistered;
    record.updated_at = Clock::get()?.unix_timestamp;
    emit!(AgentDeregistered {
        agent_record: record.key(),
    });
    Ok(())
}
