use anchor_lang::prelude::*;

/// Per-operator rolling state used by the compliance circuit.
///
/// `daily_spent_lamports` is the canonical, authoritative source for the
/// "spent so far today" value that the ZK circuit consumes as a public input.
/// It MUST live on-chain because it is the only way to defeat the previous
/// in-memory tracker that reset on every agent restart, letting an operator
/// silently exceed their daily cap.
///
/// `day_start_unix` pins the rolling window to UTC midnight; any record_payment
/// instruction whose Solana clock has crossed into the next UTC day resets
/// `daily_spent_lamports` to 0 atomically before adding the new payment.
///
/// `total_lifetime_payments` is a monotonic counter useful for audit trails
/// and dashboards. It is never reset.
///
/// PDA: ["operator_state", operator_pubkey]
/// Owner: verifier program (this program). Mutated by record_payment (added
/// in Adım 6 alongside the transfer-hook entry point).
#[account]
#[derive(InitSpace)]
pub struct OperatorState {
    pub operator: Pubkey,
    pub daily_spent_lamports: u64,
    pub day_start_unix: i64,
    pub total_lifetime_payments: u64,
    /// `policy_data_hash` of the most-recently verified proof that is still
    /// waiting to be consumed by an SPL Token-2022 transfer. Zero means
    /// "nothing pending" — the operator must produce a fresh proof before the
    /// transfer-hook will allow another transfer. Set by verify_payment_proof_v2,
    /// cleared by record_payment once the matching transfer has been observed.
    pub pending_proof_hash: [u8; 32],
    pub bump: u8,
}

impl OperatorState {
    /// Number of seconds in a UTC day. Day boundaries are computed by
    /// flooring the current unix timestamp to a multiple of this value, so
    /// every operator's "daily" window aligns with UTC midnight regardless
    /// of where the wallet or the validator are physically located.
    pub const SECONDS_PER_DAY: i64 = 86_400;

    /// Returns the UTC midnight (in unix seconds) that begins the day
    /// containing `unix_timestamp`. Negative timestamps are clamped to 0.
    pub fn day_start_for(unix_timestamp: i64) -> i64 {
        if unix_timestamp <= 0 {
            return 0;
        }
        unix_timestamp - (unix_timestamp % Self::SECONDS_PER_DAY)
    }

    /// Whether the supplied `now` timestamp belongs to a later UTC day than
    /// the one currently stored in `day_start_unix`. Used to decide if the
    /// daily window has rolled over and the spend counter must be reset.
    pub fn is_new_day(&self, now: i64) -> bool {
        Self::day_start_for(now) > self.day_start_unix
    }
}
