use anchor_lang::prelude::*;
use square_common::seeds::AGENT_SEED;

use crate::errors::RegistryError;
use crate::state::AgentRecord;
use crate::AgentOwnershipTransferred;

#[derive(Accounts)]
pub struct TransferAgentOwnership<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.creator.as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

pub fn handler(ctx: Context<TransferAgentOwnership>, new_owner: Pubkey) -> Result<()> {
    let record = &mut ctx.accounts.agent_record;
    record.require_registered()?;
    let previous_owner = record.owner;
    record.owner = new_owner;
    // Ödemeler, yeni sahibin seçmediği bir cüzdana kimlikle birlikte geçmez (profil §4.2/5).
    record.wallet = new_owner;
    record.updated_at = Clock::get()?.unix_timestamp;
    emit!(AgentOwnershipTransferred {
        agent_record: record.key(),
        previous_owner,
        new_owner,
    });
    Ok(())
}
