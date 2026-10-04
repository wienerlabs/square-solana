use anchor_lang::prelude::*;

#[error_code]
pub enum PolicyError {
    #[msg("Signer is not the institution's current authority")]
    Unauthorized,
    #[msg("Institution name exceeds 64 bytes")]
    NameTooLong,
    #[msg("Policy is not active")]
    PolicyInactive,
    #[msg("Daily ceiling must be greater than zero")]
    InvalidDailyCeiling,
    #[msg("Account is not an initialized Squads v4 multisig")]
    InvalidSquadsMultisig,
}
