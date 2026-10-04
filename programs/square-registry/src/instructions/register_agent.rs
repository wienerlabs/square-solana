use anchor_lang::prelude::*;
use square_common::seeds::AGENT_SEED;

use crate::errors::RegistryError;
use crate::state::{is_valid_agent_id, validate_agent_card, AgentRecord, AgentStatus};
use crate::AgentRegistered;

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct RegisterAgent<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Becomes both `creator` (seed) and the first `owner`.
    // Boş ya da alfabe dışı kimlik `AgentIdInvalid` alır. 32 baytı aşan kimlikle `agent_record`'ın PDA'sı
    // türetilemez ve Anchor `init` seed'lerini bu kısıttan önce türettiği için işlem orada durur
    // (`ProgramFailedToComplete`); seed'i kırpmak IDL'deki `pda` tanımını düşürürdü.
    #[account(constraint = is_valid_agent_id(&agent_id) @ RegistryError::AgentIdInvalid)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = AgentRecord::SPACE,
        seeds = [AGENT_SEED, owner.key().as_ref(), agent_id.as_bytes()],
        bump,
    )]
    pub agent_record: Account<'info, AgentRecord>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<RegisterAgent>,
    agent_id: String,
    agent_card_uri: String,
    agent_card_hash: [u8; 32],
    wallet: Pubkey,
) -> Result<()> {
    validate_agent_card(&agent_card_uri, &agent_card_hash)?;
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let record = &mut ctx.accounts.agent_record;
    record.creator = owner;
    record.owner = owner;
    record.wallet = wallet;
    record.agent_card_hash = agent_card_hash;
    record.status = AgentStatus::Active;
    record.registered_at = now;
    record.updated_at = now;
    record.bump = ctx.bumps.agent_record;
    record.agent_id = agent_id.clone();
    record.agent_card_uri = agent_card_uri;
    emit!(AgentRegistered {
        agent_record: record.key(),
        creator: owner,
        owner,
        agent_id,
        wallet,
        agent_card_hash,
    });
    Ok(())
}
