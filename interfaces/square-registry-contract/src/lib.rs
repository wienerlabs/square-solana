//! square_registry — interface contract v0.1.0 (BC-44).
//!
//! Bodiless stub: every instruction returns `RegistryError::NotImplemented`. The real program lives in
//! `programs/square-registry` (BC-07 migration, BC-15 agent records, BC-27 screening registry) and must
//! keep this interface (instruction names/args, account order, account layouts, PDA seeds, events,
//! error codes) or bump the contract version in `docs/design/program-interface.md`.
//!
//! Layout rule: fixed-size fields first, variable-size fields (String, Option) last, so indexers can
//! filter on the fixed prefix with `memcmp`.
#![allow(unused_variables, deprecated, clippy::too_many_arguments)]

use anchor_lang::prelude::*;

// Source program address (aip-registry). New Square program IDs are assigned in BC-09.
declare_id!("CgchXu2dRV3r9E1YjRhp4kbeLLtv1Xz61yoerJzp1Vbc");

pub const AGENT_ID_MAX_LEN: usize = 32;
pub const AGENT_CARD_URI_MAX_LEN: usize = 200;

#[constant]
pub const REGISTRY_CONFIG_SEED: &[u8] = b"registry_config";
#[constant]
pub const AGENT_SEED: &[u8] = b"agent";
#[constant]
pub const SCREENING_SEED: &[u8] = b"screening";

#[program]
pub mod square_registry_contract {
    use super::*;

    /// Creates the singleton registry config. Only the program upgrade authority (Squads vault) can
    /// call it (checked through `program_data`), so the config cannot be front-run.
    pub fn init_registry_config(
        ctx: Context<InitRegistryConfig>,
        screener_authority: Pubkey,
        screening_ttl_secs: i64,
    ) -> Result<()> {
        not_implemented()
    }

    /// Rotates the screener authority and the screening record lifetime.
    pub fn update_registry_config(
        ctx: Context<UpdateRegistryConfig>,
        screener_authority: Pubkey,
        screening_ttl_secs: i64,
    ) -> Result<()> {
        not_implemented()
    }

    /// Flow step 2: an agent registers; it resolves as did:aip (Solana profile, BC-14).
    /// `agent_id` is an immutable slug, unique per creator and never reusable (see `deregister_agent`).
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        agent_id: String,
        agent_card_uri: String,
        agent_card_hash: [u8; 32],
        wallet: Pubkey,
    ) -> Result<()> {
        not_implemented()
    }

    /// Updates the agent card pointer/hash and the agent wallet. Owner only. Jobs keep the wallet they
    /// were created with until the owner calls escrow `sync_agent_wallet`.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        agent_card_uri: String,
        agent_card_hash: [u8; 32],
        wallet: Pubkey,
    ) -> Result<()> {
        not_implemented()
    }

    /// Transfers ownership. The PDA is derived from the immutable `creator`, so the address stays stable.
    pub fn transfer_agent_ownership(ctx: Context<UpdateAgent>, new_owner: Pubkey) -> Result<()> {
        not_implemented()
    }

    /// Pauses (`Inactive`) or resumes (`Active`) the agent. Escrow rejects `create_job` and
    /// `accept_job` for a non-active agent; jobs already accepted can still be delivered and settled.
    /// `Deregistered` is not accepted here.
    pub fn set_agent_status(ctx: Context<UpdateAgent>, status: AgentStatus) -> Result<()> {
        not_implemented()
    }

    /// Terminal: sets `Deregistered`. The record is kept (not closed) so the same (creator, agent_id)
    /// can never be re-registered and inherit the agent's reputation or did:aip.
    pub fn deregister_agent(ctx: Context<UpdateAgent>) -> Result<()> {
        not_implemented()
    }

    /// Flow step 3: the screener service (BE-16) records a sanctions screening result for a wallet.
    /// Escrow reads it on `fund_job` (institution and agent), `buy_claim` (buyer) and release (payee).
    pub fn record_screening(
        ctx: Context<RecordScreening>,
        wallet: Pubkey,
        status: ScreeningStatus,
        source_hash: [u8; 32],
    ) -> Result<()> {
        not_implemented()
    }
}

fn not_implemented() -> Result<()> {
    err!(RegistryError::NotImplemented)
}

// ------------------------------------------------------------------ accounts (contexts)

#[derive(Accounts)]
pub struct InitRegistryConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + RegistryConfig::INIT_SPACE,
        seeds = [REGISTRY_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, RegistryConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::SquareRegistryContract>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateRegistryConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [REGISTRY_CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, RegistryConfig>,
}

#[derive(Accounts)]
#[instruction(agent_id: String)]
pub struct RegisterAgent<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// Becomes both `creator` (seed) and the first `owner`.
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + AgentRecord::INIT_SPACE,
        seeds = [AGENT_SEED, owner.key().as_ref(), agent_id.as_bytes()],
        bump
    )]
    pub agent_record: Account<'info, AgentRecord>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [AGENT_SEED, agent_record.creator.as_ref(), agent_record.agent_id.as_bytes()],
        bump = agent_record.bump,
        has_one = owner
    )]
    pub agent_record: Account<'info, AgentRecord>,
}

#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct RecordScreening<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub screener_authority: Signer<'info>,
    #[account(seeds = [REGISTRY_CONFIG_SEED], bump = config.bump, has_one = screener_authority)]
    pub config: Account<'info, RegistryConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ScreeningRecord::INIT_SPACE,
        seeds = [SCREENING_SEED, wallet.as_ref()],
        bump
    )]
    pub screening_record: Account<'info, ScreeningRecord>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ state

/// Singleton. seeds = ["registry_config"]
#[account]
#[derive(InitSpace)]
pub struct RegistryConfig {
    pub admin: Pubkey,
    pub screener_authority: Pubkey,
    /// Lifetime of a screening record; `expires_at = screened_at + screening_ttl_secs`.
    pub screening_ttl_secs: i64,
    pub bump: u8,
}

/// seeds = ["agent", creator, agent_id]
#[account]
#[derive(InitSpace)]
pub struct AgentRecord {
    /// Original registrant; part of the PDA seeds, never changes.
    pub creator: Pubkey,
    /// Current owner; can change via `transfer_agent_ownership`.
    pub owner: Pubkey,
    /// Agent wallet: signs escrow `accept_job` / `submit_work` / `list_claim` and is the default payee.
    pub wallet: Pubkey,
    /// SHA-256 of the agent card JSON served at `agent_card_uri`.
    pub agent_card_hash: [u8; 32],
    pub status: AgentStatus,
    pub registered_at: i64,
    pub updated_at: i64,
    pub bump: u8,
    #[max_len(32)]
    pub agent_id: String,
    #[max_len(200)]
    pub agent_card_uri: String,
}

/// seeds = ["screening", wallet]
#[account]
#[derive(InitSpace)]
pub struct ScreeningRecord {
    pub wallet: Pubkey,
    pub status: ScreeningStatus,
    /// Hash of the screening evidence (provider response / list version).
    pub source_hash: [u8; 32],
    pub screened_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AgentStatus {
    Active,
    Inactive,
    /// Terminal; set by `deregister_agent`.
    Deregistered,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ScreeningStatus {
    Clear,
    Flagged,
}

// ------------------------------------------------------------------ events

#[event]
pub struct RegistryConfigUpdated {
    pub admin: Pubkey,
    pub screener_authority: Pubkey,
    pub screening_ttl_secs: i64,
}

#[event]
pub struct AgentRegistered {
    pub agent_record: Pubkey,
    pub creator: Pubkey,
    pub owner: Pubkey,
    pub agent_id: String,
    pub wallet: Pubkey,
    pub agent_card_hash: [u8; 32],
}

#[event]
pub struct AgentUpdated {
    pub agent_record: Pubkey,
    pub wallet: Pubkey,
    pub agent_card_hash: [u8; 32],
}

#[event]
pub struct AgentOwnershipTransferred {
    pub agent_record: Pubkey,
    pub previous_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct AgentStatusChanged {
    pub agent_record: Pubkey,
    pub status: AgentStatus,
}

#[event]
pub struct AgentDeregistered {
    pub agent_record: Pubkey,
}

#[event]
pub struct ScreeningRecorded {
    pub wallet: Pubkey,
    pub status: ScreeningStatus,
    pub source_hash: [u8; 32],
    pub expires_at: i64,
}

// ------------------------------------------------------------------ errors

/// Codes start at 6000 in every Square program; clients map errors by (program id, code).
/// (`#[error_code(offset)]` is not used: Anchor 0.31 IDLs ignore it.)
#[error_code]
pub enum RegistryError {
    #[msg("Agent ID must be 1-32 bytes")]
    AgentIdInvalid,
    #[msg("Agent card URI exceeds 200 bytes")]
    AgentCardUriTooLong,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Agent is not active")]
    AgentInactive,
    #[msg("Agent is deregistered")]
    AgentDeregistered,
    #[msg("Status cannot be set with this instruction")]
    InvalidAgentStatus,
    #[msg("Screening TTL must be positive")]
    InvalidScreeningTtl,
    /// Stub-only; always the last variant so removing it never shifts the contract error codes.
    #[msg("Interface contract stub: not implemented")]
    NotImplemented,
}
