use anchor_lang::prelude::*;

declare_id!("CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc");

/// AIP Agent Registry Program
///
/// On-chain agent card storage and discovery.
/// Agents register their card data on Solana — anyone can query and discover them.
#[program]
pub mod aip_registry {
    use super::*;

    /// Register a new agent on-chain.
    /// PDA seeds: ["agent", did_seed] where did_seed = sha256(did)[0..32]
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        did_seed: [u8; 32],
        did: String,
        name: String,
        endpoint: String,
        wallet_address: Pubkey,
        agent_type: u8,
        capabilities_json: String,
        version: String,
    ) -> Result<()> {
        require!(did.len() <= 100, RegistryError::DidTooLong);
        require!(name.len() <= 64, RegistryError::NameTooLong);
        require!(endpoint.len() <= 200, RegistryError::EndpointTooLong);
        require!(capabilities_json.len() <= 512, RegistryError::CapabilitiesTooLong);
        require!(version.len() <= 16, RegistryError::VersionTooLong);
        require!(agent_type <= 2, RegistryError::InvalidAgentType);

        let record = &mut ctx.accounts.agent_record;
        record.owner = ctx.accounts.owner.key();
        record.did_seed = did_seed;
        record.did = did;
        record.name = name;
        record.endpoint = endpoint;
        record.wallet_address = wallet_address;
        record.agent_type = agent_type;
        record.capabilities_json = capabilities_json;
        record.version = version;
        record.registered_at = Clock::get()?.unix_timestamp;
        record.updated_at = Clock::get()?.unix_timestamp;
        record.bump = ctx.bumps.agent_record;

        msg!("Agent registered: {}", record.name);
        Ok(())
    }

    /// Update an existing agent record.
    /// Only the original owner can update.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        name: String,
        endpoint: String,
        wallet_address: Pubkey,
        agent_type: u8,
        capabilities_json: String,
        version: String,
    ) -> Result<()> {
        require!(name.len() <= 64, RegistryError::NameTooLong);
        require!(endpoint.len() <= 200, RegistryError::EndpointTooLong);
        require!(capabilities_json.len() <= 512, RegistryError::CapabilitiesTooLong);
        require!(version.len() <= 16, RegistryError::VersionTooLong);
        require!(agent_type <= 2, RegistryError::InvalidAgentType);

        let record = &mut ctx.accounts.agent_record;
        record.name = name;
        record.endpoint = endpoint;
        record.wallet_address = wallet_address;
        record.agent_type = agent_type;
        record.capabilities_json = capabilities_json;
        record.version = version;
        record.updated_at = Clock::get()?.unix_timestamp;

        msg!("Agent updated: {}", record.name);
        Ok(())
    }

    /// Deregister an agent — close the PDA and return rent to owner.
    pub fn deregister_agent(_ctx: Context<DeregisterAgent>) -> Result<()> {
        msg!("Agent deregistered");
        Ok(())
    }
}

// ---------------------------------------------------------------
// Account structures
// ---------------------------------------------------------------

#[derive(Accounts)]
#[instruction(did_seed: [u8; 32])]
pub struct RegisterAgent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        init,
        payer = owner,
        space = AgentRecord::SIZE,
        seeds = [b"agent", did_seed.as_ref()],
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
        seeds = [b"agent", agent_record.did_seed.as_ref()],
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
        seeds = [b"agent", agent_record.did_seed.as_ref()],
        bump = agent_record.bump,
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

// ---------------------------------------------------------------
// State
// ---------------------------------------------------------------

#[account]
pub struct AgentRecord {
    pub owner: Pubkey,              // 32
    pub did_seed: [u8; 32],         // 32 — sha256(did)[0..32]
    pub did: String,                // 4 + 100
    pub name: String,               // 4 + 64
    pub endpoint: String,           // 4 + 200
    pub wallet_address: Pubkey,     // 32
    pub agent_type: u8,             // 1 — 0=LLM, 1=Task, 2=Execution
    pub capabilities_json: String,  // 4 + 512
    pub version: String,            // 4 + 16
    pub registered_at: i64,         // 8
    pub updated_at: i64,            // 8
    pub bump: u8,                   // 1
}

impl AgentRecord {
    // 8 (disc) + 32 + 32 + 104 + 68 + 204 + 32 + 1 + 516 + 20 + 8 + 8 + 1 = 1034
    pub const SIZE: usize = 1040; // with padding
}

// ---------------------------------------------------------------
// Errors
// ---------------------------------------------------------------

#[error_code]
pub enum RegistryError {
    #[msg("DID too long: maximum 100 characters")]
    DidTooLong,
    #[msg("Name too long: maximum 64 characters")]
    NameTooLong,
    #[msg("Endpoint too long: maximum 200 characters")]
    EndpointTooLong,
    #[msg("Capabilities JSON too long: maximum 512 characters")]
    CapabilitiesTooLong,
    #[msg("Version too long: maximum 16 characters")]
    VersionTooLong,
    #[msg("Invalid agent type: must be 0 (LLM), 1 (Task), or 2 (Execution)")]
    InvalidAgentType,
    #[msg("Unauthorized: only the owner can modify this record")]
    Unauthorized,
}
