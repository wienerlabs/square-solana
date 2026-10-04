use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Agent ID must be 1-32 characters from [A-Za-z0-9_-]")]
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
    #[msg("Agent card hash must be all zero exactly when the agent card URI is empty")]
    AgentCardHashInvalid,
}
