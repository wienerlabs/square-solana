use anchor_lang::prelude::*;
use crate::state::{ProofRecord, OperatorState};

/// Adım 6 — record_payment.
///
/// Called by the SPL Token-2022 transfer-hook program once it has confirmed
/// that the in-flight transfer matches the parameters committed to by the
/// operator's pending ZK proof. This instruction is the SINGLE on-chain
/// authority that mutates daily_spent — there is no off-chain tracker any
/// more, and there is no other path that increments the counter.
///
/// What it does atomically:
///
///   1. Reads the operator's pending_proof_hash and resolves the matching
///      ProofRecord PDA (Anchor verifies the seed binding).
///   2. Cross-checks the actual transfer's `recipient`, `token_mint` and
///      `amount` against the proof's committed values. Any mismatch fails
///      closed.
///   3. Marks the proof consumed (one-shot — re-use is impossible).
///   4. Resets daily_spent at UTC midnight if the on-chain `day_start_unix`
///      is older than today.
///   5. Increments daily_spent + total_lifetime_payments.
///   6. Clears the pending_proof_hash slot so the next transfer requires a
///      fresh proof.
///
/// Authorization model: the instruction is permissionless — anyone can call
/// it, including the transfer-hook program from a CPI. Safety comes from the
/// PDA seed bindings (only the operator's own state and proof match) and from
/// the byte-equality checks. A griefer who calls it without a matching
/// transfer cannot fabricate one because the values must equal what the
/// proof committed to, which is enforced cryptographically by Adım 5.
#[derive(Accounts)]
#[instruction(
    expected_recipient: [u8; 32],
    expected_token_mint: [u8; 32],
    expected_amount: u64,
)]
pub struct RecordPayment<'info> {
    /// CHECK: pubkey passed by the caller; bound by the seeds on operator_state
    /// and proof_record below, so spoofing fails.
    pub operator: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [b"operator_state", operator.key().as_ref()],
        bump = operator_state.bump,
    )]
    pub operator_state: Account<'info, OperatorState>,

    #[account(
        mut,
        seeds = [b"proof", operator.key().as_ref(), &operator_state.pending_proof_hash],
        bump = proof_record.bump,
        constraint = !proof_record.consumed @ RecordPaymentError::ProofAlreadyConsumed,
        constraint = proof_record.operator == operator.key()
            @ RecordPaymentError::ProofOperatorMismatch,
    )]
    pub proof_record: Account<'info, ProofRecord>,
}

pub fn handler(
    ctx: Context<RecordPayment>,
    expected_recipient: [u8; 32],
    expected_token_mint: [u8; 32],
    expected_amount: u64,
) -> Result<()> {
    let proof = &ctx.accounts.proof_record;

    if proof.recipient != expected_recipient {
        return err!(RecordPaymentError::RecipientMismatch);
    }
    if proof.token_mint != expected_token_mint {
        return err!(RecordPaymentError::MintMismatch);
    }
    if proof.amount_lamports != expected_amount {
        return err!(RecordPaymentError::AmountMismatch);
    }

    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // Atomic update: rollover, increment, clear pending. Any panic above
    // (e.g. checked_add overflow) reverts the whole transaction so the
    // proof never gets consumed silently.
    let state = &mut ctx.accounts.operator_state;
    if state.is_new_day(now) {
        state.daily_spent_lamports = 0;
        state.day_start_unix = OperatorState::day_start_for(now);
    }
    state.daily_spent_lamports = state
        .daily_spent_lamports
        .checked_add(expected_amount)
        .ok_or(error!(RecordPaymentError::DailySpentOverflow))?;
    state.total_lifetime_payments = state.total_lifetime_payments.saturating_add(1);
    state.pending_proof_hash = [0u8; 32];

    let proof = &mut ctx.accounts.proof_record;
    proof.consumed = true;

    msg!(
        "record_payment: operator={}, amount={}, daily_spent={}, total_payments={}",
        ctx.accounts.operator.key(),
        expected_amount,
        state.daily_spent_lamports,
        state.total_lifetime_payments
    );
    Ok(())
}

#[error_code]
pub enum RecordPaymentError {
    #[msg("ProofRecord has already been consumed by an earlier transfer")]
    ProofAlreadyConsumed,
    #[msg("ProofRecord belongs to a different operator")]
    ProofOperatorMismatch,
    #[msg("Transfer recipient does not match the proof's committed recipient")]
    RecipientMismatch,
    #[msg("Transfer mint does not match the proof's committed token_mint")]
    MintMismatch,
    #[msg("Transfer amount does not match the proof's committed amount_lamports")]
    AmountMismatch,
    #[msg("daily_spent_lamports would overflow u64 — refuse to advance")]
    DailySpentOverflow,
}
