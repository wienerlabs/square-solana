use anchor_lang::prelude::*;

/// Per-operator rolling state used by the compliance circuit.
///
/// `daily_spent_lamports` is the canonical, authoritative source for the
/// "spent so far today" value that the ZK circuit consumes as a public input.
/// It MUST live on-chain because it is the only way to defeat the previous
/// in-memory tracker that reset on every agent restart, letting an operator
/// silently exceed their daily cap.
///
/// `day_start_unix` pins the rolling window to UTC midnight; any instruction
/// that advances the counter after the Solana clock has crossed into the next UTC day resets
/// `daily_spent_lamports` to 0 atomically before adding the new payment.
///
/// `total_lifetime_payments` is a monotonic counter useful for audit trails
/// and dashboards. It is never reset.
///
/// PDA: ["operator_state", operator_pubkey]
/// Owner: verifier program (this program). Mutated by verify_mpp_payment_proof.
/// The transfer-hook path (`record_payment`) that advanced it for the Solana
/// flow was removed in BC-11; BC-21 advances it through `record_release`.
#[account]
#[derive(InitSpace)]
pub struct OperatorState {
    pub operator: Pubkey,
    pub daily_spent_lamports: u64,
    pub day_start_unix: i64,
    pub total_lifetime_payments: u64,
    /// Written only by the transfer-hook flow that BC-11 removed; no remaining
    /// instruction reads or writes it. Kept so the account layout stays
    /// unchanged until BC-21 moves to the BC-44 `OperatorState` layout.
    pub pending_proof_hash: [u8; 32],
    pub bump: u8,
}

impl OperatorState {
    /// Returns the UTC midnight (in unix seconds) that begins the day
    /// containing `unix_timestamp`; shared with the other programs through
    /// `square_common::time::day_start` (BC-10). Negative timestamps are clamped to 0.
    pub fn day_start_for(unix_timestamp: i64) -> i64 {
        square_common::time::day_start(unix_timestamp)
    }

    /// Whether the supplied `now` timestamp belongs to a later UTC day than
    /// the one currently stored in `day_start_unix`. Used to decide if the
    /// daily window has rolled over and the spend counter must be reset.
    pub fn is_new_day(&self, now: i64) -> bool {
        Self::day_start_for(now) > self.day_start_unix
    }
}
