//! square_verifier hesapları (program arayüzü §5, §10.3).

use anchor_lang::prelude::*;

/// Singleton. seeds = ["verifier_config"]
#[account]
#[derive(InitSpace)]
pub struct VerifierConfig {
    pub admin: Pubkey,
    /// Owner of `Job` / `ClaimListing`; its ["escrow_authority"] PDA may call `record_release`.
    pub escrow_program: Pubkey,
    /// Owner of `Institution` / `Policy` accounts read by the verifier.
    pub policy_program: Pubkey,
    /// Ed25519 key whose attestations bind Stripe (MPP) payments to fiat jobs; rotated by the admin
    /// with `update_mpp_authority` (ADR 0024).
    pub mpp_authority: Pubkey,
    /// Version of the embedded verifying key (bumped after the phase-2 ceremony, BC-38).
    pub vk_version: u16,
    pub bump: u8,
}

/// seeds = ["operator_state", institution] (institution = square_policy `Institution` PDA)
#[account]
#[derive(InitSpace)]
pub struct OperatorState {
    pub institution: Pubkey,
    /// Released amount in the current UTC day (settlement-mint atomic units); circuit public input.
    pub daily_spent: u64,
    /// UTC midnight that starts the current window.
    pub day_start_unix: i64,
    pub total_lifetime_payments: u64,
    pub bump: u8,
}

/// seeds = ["release_proof", job]
#[account]
#[derive(InitSpace)]
pub struct ReleaseProof {
    pub job: Pubkey,
    /// square_policy `Institution` PDA (key of the `OperatorState` it advances).
    pub institution: Pubkey,
    pub policy: Pubkey,
    /// Address the proof is bound to: the agent wallet, or the claim buyer if the receivable was sold.
    pub payee: Pubkey,
    /// Amount the payee receives; escrow compares it with its own net at release.
    pub net_amount: u64,
    pub mint: Pubkey,
    /// `OperatorState.daily_spent` the proof was built against; a different value at release = stale.
    pub daily_spent_before: u64,
    pub proof_timestamp: i64,
    pub verdict: ReleaseVerdict,
    /// Policy rule that refused the release (0 when compliant). Codes defined with the circuit (BC-19).
    pub refusal_code: u16,
    pub consumed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ReleaseVerdict {
    Compliant,
    Refused,
}
