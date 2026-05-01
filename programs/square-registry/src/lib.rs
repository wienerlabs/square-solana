use anchor_lang::prelude::*;

declare_id!("CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc");

/// AIP Agent Registry Program
///
/// On-chain agent card storage and discovery.
/// One wallet can register multiple agents, each with a unique agent_id.
/// PDA seeds: ["agent", owner, agent_id]
#[program]
pub mod aip_registry {
    use super::*;

    /// Register a new agent on-chain.
    /// agent_id is a unique slug per owner (max 32 chars, immutable after creation).
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        did: String,
        name: String,
        endpoint: String,
        wallet_address: Pubkey,
        agent_type: AgentType,
        capabilities: Vec<Capability>,
        price_per_task: u64,
        version: String,
    ) -> Result<()> {
        require!(agent_id.len() > 0 && agent_id.len() <= 32, RegistryError::AgentIdInvalid);
        require!(did.len() <= 100, RegistryError::DidTooLong);
        require!(name.len() <= 64, RegistryError::NameTooLong);
        require!(endpoint.len() <= 200, RegistryError::EndpointTooLong);
        require!(version.len() <= 16, RegistryError::VersionTooLong);
        validate_capabilities(&capabilities)?;

        let record = &mut ctx.accounts.agent_record;
        record.owner = ctx.accounts.owner.key();
        record.agent_id = agent_id;
        record.did = did;
        record.name = name;
        record.endpoint = endpoint;
        record.wallet_address = wallet_address;
        record.agent_type = agent_type;
        record.capabilities = capabilities;
        record.price_per_task = price_per_task;
        record.version = version;
        record.registered_at = Clock::get()?.unix_timestamp;
        record.updated_at = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.agent_record;

        msg!("Agent registered: {} ({})", record.name, record.agent_id);
        Ok(())
    }

    /// Update an existing agent record.
    /// Only the original owner can update. agent_id cannot change.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        name: String,
        endpoint: String,
        wallet_address: Pubkey,
        agent_type: AgentType,
        capabilities: Vec<Capability>,
        price_per_task: u64,
        version: String,
    ) -> Result<()> {
        require!(name.len() <= 64, RegistryError::NameTooLong);
        require!(endpoint.len() <= 200, RegistryError::EndpointTooLong);
        require!(version.len() <= 16, RegistryError::VersionTooLong);
        validate_capabilities(&capabilities)?;

        let record = &mut ctx.accounts.agent_record;
        record.name = name;
        record.endpoint = endpoint;
        record.wallet_address = wallet_address;
        record.agent_type = agent_type;
        record.capabilities = capabilities;
        record.price_per_task = price_per_task;
        record.version = version;
        record.updated_at = Clock::get()?.unix_timestamp;

        msg!("Agent updated: {} ({})", record.name, record.agent_id);
        Ok(())
    }

    /// Deregister an agent - close the PDA and return rent to owner.
    pub fn deregister_agent(_ctx: Context<DeregisterAgent>) -> Result<()> {
        msg!("Agent deregistered");
        Ok(())
    }
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

fn validate_capabilities(caps: &[Capability]) -> Result<()> {
    require!(caps.len() <= AgentRecord::MAX_CAPABILITIES, RegistryError::TooManyCapabilities);
    for cap in caps {
        require!(cap.name.len() > 0 && cap.name.len() <= 32, RegistryError::CapabilityNameInvalid);
        require!(cap.description.len() <= 64, RegistryError::CapabilityDescriptionTooLong);
    }
    Ok(())
}

// ---------------------------------------------------------------
// Account structures
// ---------------------------------------------------------------

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = AgentRecord::SIZE,
        seeds = [b"agent", owner.key().as_ref(), agent_id.as_bytes()],
        bump
    )]
    pub agent_record: Account<'info, AgentRecord>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        constraint = owner.key() == agent_record.owner @ RegistryError::Unauthorized,
    )]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        constraint = owner.key() == agent_record.owner @ RegistryError::Unauthorized,
        seeds = [b"agent", owner.key().as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentType {
    Llm,        // 0
    Task,       // 1
    Execution,  // 2
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct Capability {
    pub name: String,        // 4 + 32 - capability identifier (e.g., "text-completion")
    pub description: String, // 4 + 64 - short human-readable summary
}

#[account]
pub struct AgentRecord {
    pub owner: Pubkey,                 // 32
    pub agent_id: String,              // 4 + 32 - unique slug per owner
    pub did: String,                   // 4 + 100 - auto-generated DID
    pub name: String,                  // 4 + 64
    pub endpoint: String,              // 4 + 200
    pub wallet_address: Pubkey,        // 32 - off-chain signing key (may differ from owner)
    pub agent_type: AgentType,         // 1 - Borsh-encoded enum tag
    pub capabilities: Vec<Capability>, // 4 + N * 104, max N = 8
    pub price_per_task: u64,           // 8 - base price in lamports per capability invocation
    pub version: String,               // 4 + 16
    pub registered_at: i64,            // 8
    pub updated_at: i64,               // 8
    pub bump: u8,                      // 1
}

impl AgentRecord {
    pub const MAX_CAPABILITIES: usize = 8;
    pub const CAP_SIZE: usize = (4 + 32) + (4 + 64); // 104

    // 8 (discriminator)
    // + 32 (owner)
    // + 36 (agent_id)
    // + 104 (did)
    // + 68 (name)
    // + 204 (endpoint)
    // + 32 (wallet_address)
    // + 1 (agent_type)
    // + 4 + 8*104 = 836 (capabilities)
    // + 8 (price_per_task)
    // + 20 (version)
    // + 8 (registered_at)
    // + 8 (updated_at)
    // + 1 (bump)
    // = 1366
    pub const SIZE: usize = 8
        + 32
        + (4 + 32)
        + (4 + 100)
        + (4 + 64)
        + (4 + 200)
        + 32
        + 1
        + (4 + Self::MAX_CAPABILITIES * Self::CAP_SIZE)
        + 8
        + (4 + 16)
        + 8
        + 8
        + 1;
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

#[error_code]
pub enum RegistryError {
    #[msg("Agent ID invalid: 1-32 characters required")]
    AgentIdInvalid,
    #[msg("DID too long: maximum 100 characters")]
    DidTooLong,
    #[msg("Name too long: maximum 64 characters")]
    NameTooLong,
    #[msg("Endpoint too long: maximum 200 characters")]
    EndpointTooLong,
    #[msg("Version too long: maximum 16 characters")]
    VersionTooLong,
    #[msg("Too many capabilities: maximum 8 allowed")]
    TooManyCapabilities,
    #[msg("Capability name invalid: 1-32 characters required")]
    CapabilityNameInvalid,
    #[msg("Capability description too long: maximum 64 characters")]
    CapabilityDescriptionTooLong,
    #[msg("Unauthorized: only the owner can modify this record")]
    Unauthorized,
}
