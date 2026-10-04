use anchor_lang::prelude::*;
use square_common::seeds::AGENT_SEED;

use crate::errors::RegistryError;
use crate::state::{validate_agent_card, AgentRecord};
use crate::AgentUpdated;

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.creator.as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
        has_one = owner @ RegistryError::Unauthorized,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

pub fn handler(
    ctx: Context<UpdateAgent>,
    agent_card_uri: String,
    agent_card_hash: [u8; 32],
    wallet: Pubkey,
) -> Result<()> {
    let record = &mut ctx.accounts.agent_record;
    record.require_registered()?;
    validate_agent_card(&agent_card_uri, &agent_card_hash)?;
    record.agent_card_uri = agent_card_uri;
    record.agent_card_hash = agent_card_hash;
    record.wallet = wallet;
    record.updated_at = Clock::get()?.unix_timestamp;
    emit!(AgentUpdated {
        agent_record: record.key(),
        wallet,
        agent_card_hash,
    });
    Ok(())
}
