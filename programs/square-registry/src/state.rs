use anchor_lang::prelude::*;

use crate::errors::RegistryError;

/// seeds = ["agent", creator, agent_id]
#[account]
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
    pub agent_id: String,
    pub agent_card_uri: String,
}

impl AgentRecord {
    pub const MAX_AGENT_ID_LEN: usize = 32;
    pub const MAX_AGENT_CARD_URI_LEN: usize = 200;
    pub const SPACE: usize = 8
        + 32 * 3
        + 32
        + 1
        + 8
        + 8
        + 1
        + (4 + Self::MAX_AGENT_ID_LEN)
        + (4 + Self::MAX_AGENT_CARD_URI_LEN);

    /// Kayıt değiştirilebilir mi: `Deregistered` kalıcıdır (profil §4.2/3).
    pub fn require_registered(&self) -> Result<()> {
        require!(
            self.status != AgentStatus::Deregistered,
            RegistryError::AgentDeregistered
        );
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active,
    Inactive,
    Deregistered,
}

/// Singleton. seeds = ["registry_config"]
#[account]
pub struct RegistryConfig {
    pub admin: Pubkey,
    pub screener_authority: Pubkey,
    /// Lifetime of a screening record; `expires_at = screened_at + screening_ttl_secs`.
    pub screening_ttl_secs: i64,
    pub bump: u8,
}

impl RegistryConfig {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

/// seeds = ["screening", wallet]
#[account]
pub struct ScreeningRecord {
    pub wallet: Pubkey,
    pub status: ScreeningStatus,
    /// Hash of the screening evidence (provider response / list version).
    pub source_hash: [u8; 32],
    pub screened_at: i64,
    pub expires_at: i64,
    pub bump: u8,
}

impl ScreeningRecord {
    pub const SPACE: usize = 8 + 32 + 1 + 32 + 8 + 8 + 1;
}

// Screening sonucu: `ScreeningRecord` ve `ScreeningRecorded` event'inin alanı. Doküman yorumu IDL'e girer,
// sözleşmedeki tip yorumsuz olduğu için düz yorum.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScreeningStatus {
    Clear,
    Flagged,
}

/// TTL pozitif olmalı (`InvalidScreeningTtl`); `init_registry_config` ve `update_registry_config`'te.
pub fn validate_screening_ttl(screening_ttl_secs: i64) -> Result<()> {
    require!(screening_ttl_secs > 0, RegistryError::InvalidScreeningTtl);
    Ok(())
}

/// `agent_id`: `[A-Za-z0-9_-]{1,32}` (did:aip v2 Solana profili §3.4, §4.1). `register_agent`'ın hesap
/// kısıtında denetlenir; 32 baytı aşan kimlik zaten PDA seed'i olarak türetilemez.
pub fn is_valid_agent_id(agent_id: &str) -> bool {
    (1..=AgentRecord::MAX_AGENT_ID_LEN).contains(&agent_id.len())
        && agent_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Kart işaretçisi ve hash'i birlikte yazılır (profil §4.2/4): boş URI sıfır hash'le gelir; dolu bir
/// URI'nin hash'i kartın SHA-256'sıdır ve sıfır olamaz.
pub fn validate_agent_card(agent_card_uri: &str, agent_card_hash: &[u8; 32]) -> Result<()> {
    require!(
        agent_card_uri.len() <= AgentRecord::MAX_AGENT_CARD_URI_LEN,
        RegistryError::AgentCardUriTooLong
    );
    require!(
        agent_card_uri.is_empty() == (*agent_card_hash == [0u8; 32]),
        RegistryError::AgentCardHashInvalid
    );
    Ok(())
}
