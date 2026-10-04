use anchor_lang::prelude::*;

/// Programın tek hata kümesi. Anchor 1.x program başına tek `#[error_code]` bloğu kabul eder;
/// talimat dosyalarındaki dört ayrı küme (BC-08) burada birleşti.
#[error_code]
pub enum PolicyRegistryError {
    #[msg("Policy is inactive and cannot be updated")]
    PolicyInactive,
    #[msg("Signer is not the authorized multisig for this operator")]
    UnauthorizedMultisig,
    #[msg("Account is not owned by the Squads v4 program")]
    InvalidSquadsProgram,
    #[msg("Signer does not match the vault PDA derived from the Squads multisig")]
    InvalidVaultPDA,
    #[msg("Squads multisig account is not initialized")]
    MultisigNotInitialized,
}
