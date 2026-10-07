//! PDA seed'leri (program arayüzü §5). Sözleşme seed'leri sözleşme IDL'lerinin `constants`
//! bölümünden gelir; burada yeniden yazılmaz.

pub use crate::contract::square_escrow_contract::constants::{
    BOND_SEED, CLAIM_SEED, CONFIG_SEED, ESCROW_AUTHORITY_SEED, JOB_SEED, REPUTATION_SEED,
    VALIDATION_SEED, VAULT_SEED,
};
pub use crate::contract::square_policy_contract::constants::{INSTITUTION_SEED, POLICY_SEED};
pub use crate::contract::square_registry_contract::constants::{
    AGENT_SEED, REGISTRY_CONFIG_SEED, SCREENING_SEED,
};
pub use crate::contract::square_verifier_contract::constants::{
    OPERATOR_STATE_SEED, PREFLIGHT_PROOF_SEED, RELEASE_PROOF_SEED, VERIFIER_CONFIG_SEED,
};

/// Taşınan programların sözleşmede karşılığı olmayan seed'leri. Programlar sözleşmeye geçtikçe
/// (BC-15, BC-17, BC-21) kaldırılır.
pub mod legacy {
    /// Aperture `ComplianceStatus` (`["compliance", operator]`).
    pub const COMPLIANCE_SEED: &[u8] = b"compliance";
    /// Aperture `ProofRecord` (`["proof", operator, public_inputs[1]]`); sözleşmede `ReleaseProof`.
    pub const PROOF_SEED: &[u8] = b"proof";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sözleşmedeki seed tablosuyla (program arayüzü §5) bayt bayt aynı.
    #[test]
    fn contract_seed_values() {
        let table: [(&[u8], &[u8]); 17] = [
            (AGENT_SEED, b"agent"),
            (REGISTRY_CONFIG_SEED, b"registry_config"),
            (SCREENING_SEED, b"screening"),
            (INSTITUTION_SEED, b"institution"),
            (POLICY_SEED, b"policy"),
            (VERIFIER_CONFIG_SEED, b"verifier_config"),
            (OPERATOR_STATE_SEED, b"operator_state"),
            (RELEASE_PROOF_SEED, b"release_proof"),
            (PREFLIGHT_PROOF_SEED, b"preflight_proof"),
            (CONFIG_SEED, b"config"),
            (JOB_SEED, b"job"),
            (VAULT_SEED, b"escrow_token"),
            (BOND_SEED, b"bond"),
            (CLAIM_SEED, b"claim"),
            (REPUTATION_SEED, b"reputation"),
            (VALIDATION_SEED, b"validation"),
            (ESCROW_AUTHORITY_SEED, b"escrow_authority"),
        ];
        for (constant, expected) in table {
            assert_eq!(constant, expected);
        }
    }
}
