use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct ProofRecord {
    pub operator: Pubkey,
    pub policy_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub image_id: [u32; 8],
    pub journal_digest: [u8; 32],
    pub timestamp: i64,
    pub verified: bool,
    /// Set to true by record_payment once the SPL Token-2022 transfer has been
    /// observed and the daily-spend has been incremented. A consumed proof
    /// cannot be reused — it has done its job and any subsequent transfer
    /// requires a fresh ZK proof.
    pub consumed: bool,
    /// Raw 32-byte transfer-destination wallet pubkey the proof commits to.
    /// Filled from public_inputs[2] (high 16 bytes) + public_inputs[3] (low
    /// 16 bytes) at verify_payment_proof_v2 time.
    pub recipient: [u8; 32],
    /// Raw 32-byte SPL mint pubkey, derived the same way from public_inputs[5,6].
    pub token_mint: [u8; 32],
    /// Lamport amount the proof committed to (public_inputs[4]). The transfer-
    /// hook checks the actual transfer amount against this exact value.
    pub amount_lamports: u64,
    pub bump: u8,
}
