//! Square registry programı (program arayüzü §10.1). Akışın 2. adımı (BC-15): agent kaydolur ve did:aip
//! olarak çözümlenir (did:aip v2 Solana profili, BC-14). Zincirde DID metni yoktur: DID küme, program
//! kimliği ve kayıt adresinden türetilir (profil §4.2). Kayıt bir A2A agent card'ına işaret eder:
//! `agent_card_uri` ve kartın SHA-256'sı `agent_card_hash`.
//!
//! Akışın 3. adımı (BC-27): screener servisi cüzdanların sanctions screening sonucunu `ScreeningRecord`'a
//! yazar; escrow fonlama, alacak satışı ve release'te kaydın temiz ve taze olmasını ister
//! (`square_common::screening`). Screener'ı ve kayıtların ömrünü `RegistryConfig` tutar.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
pub use state::{AgentStatus, ScreeningStatus};

declare_id!("AL5p4aTWrmBmWa4vxJFbBjQG7Xnx2juc15FJRGpwSsA9");

square_common::square_registry_events!();

// PDA seed'leri IDL'de de yayımlanır; değerler sözleşmeden (square-common).
#[constant]
pub const AGENT_SEED: &[u8] = square_common::seeds::AGENT_SEED;
#[constant]
pub const REGISTRY_CONFIG_SEED: &[u8] = square_common::seeds::REGISTRY_CONFIG_SEED;
#[constant]
pub const SCREENING_SEED: &[u8] = square_common::seeds::SCREENING_SEED;

#[program]
pub mod square_registry {
    use super::*;

    /// Terminal: sets `Deregistered`. The record is kept (not closed) so the same (creator, agent_id)
    /// can never be re-registered and inherit the agent's reputation or did:aip.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        instructions::deregister_agent::handler(ctx)
    }

    /// Creates the singleton registry config. Only the program upgrade authority (Squads vault) can
    /// call it (checked through `program_data`), so the config cannot be front-run.
    pub fn init_registry_config(
        ctx: Context<InitRegistryConfig>,
        screener_authority: Pubkey,
        screening_ttl_secs: i64,
    ) -> Result<()> {
        instructions::init_registry_config::handler(ctx, screener_authority, screening_ttl_secs)
    }

    /// Flow step 3: the screener service (BE-16) records a sanctions screening result for a wallet.
    /// Escrow reads it on `fund_job` (institution and agent), `buy_claim` (buyer) and release (payee).
    pub fn record_screening(
        ctx: Context<RecordScreening>,
        wallet: Pubkey,
        status: ScreeningStatus,
        source_hash: [u8; 32],
    ) -> Result<()> {
        instructions::record_screening::handler(ctx, wallet, status, source_hash)
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
        instructions::register_agent::handler(
            ctx,
            agent_id,
            agent_card_uri,
            agent_card_hash,
            wallet,
        )
    }

    /// Pauses (`Inactive`) or resumes (`Active`) the agent. Escrow rejects `create_job` and
    /// `accept_job` for a non-active agent; jobs already accepted can still be delivered and settled.
    /// `Deregistered` is not accepted here.
    pub fn set_agent_status(ctx: Context<SetAgentStatus>, status: AgentStatus) -> Result<()> {
        instructions::set_agent_status::handler(ctx, status)
    }

    /// Transfers ownership and resets `wallet` to the new owner (did:aip Solana profile §4.2). The PDA
    /// is derived from the immutable `creator`, so the address stays stable.
    pub fn transfer_agent_ownership(
        ctx: Context<TransferAgentOwnership>,
        new_owner: Pubkey,
    ) -> Result<()> {
        instructions::transfer_agent_ownership::handler(ctx, new_owner)
    }

    /// Updates the agent card pointer/hash and the agent wallet. Owner only. Jobs keep the wallet they
    /// were created with until the owner calls escrow `sync_agent_wallet`.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        agent_card_uri: String,
        agent_card_hash: [u8; 32],
        wallet: Pubkey,
    ) -> Result<()> {
        instructions::update_agent::handler(ctx, agent_card_uri, agent_card_hash, wallet)
    }

    /// Rotates the screener authority and the screening record lifetime.
    pub fn update_registry_config(
        ctx: Context<UpdateRegistryConfig>,
        screener_authority: Pubkey,
        screening_ttl_secs: i64,
    ) -> Result<()> {
        instructions::update_registry_config::handler(ctx, screener_authority, screening_ttl_secs)
    }
}
