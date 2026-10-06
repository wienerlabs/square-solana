//! İspatı job'a bağlayan iki talimatın (`set_compliance_proof`, `verify_mpp_payment_proof`) ortak
//! kuralları: ispatın anı, kurumun o andaki günlük sayacı ve ilk ispatta açılan `OperatorState`.

use anchor_lang::prelude::*;
use square_common::release::daily_spent_at;
use square_common::time::day_start;

use crate::errors::VerifierError;
use crate::state::OperatorState;
use crate::CLOCK_TOLERANCE_SECS;

/// İspatın anı zincirin saatine tolerans içinde yakın olmalı (ADR 0012).
pub fn require_current(proof_timestamp: i64, now: i64) -> Result<()> {
    require!(
        proof_timestamp >= 0 && (proof_timestamp - now).abs() <= CLOCK_TOLERANCE_SECS,
        VerifierError::StaleProof
    );
    Ok(())
}

/// Kurumun ilk ispatında `init_if_needed` hesabı henüz kurulmamıştır.
pub fn is_new(state: &OperatorState) -> bool {
    state.institution == Pubkey::default()
}

/// Sayaç: ispat anının UTC gününe göre (gün dönümü uygulanmış). Durum daha yeni bir güne aitse bu an
/// için sayaç bilinemez.
pub fn daily_spent_before(state: &OperatorState, proof_timestamp: i64) -> Result<u64> {
    if is_new(state) {
        return Ok(0);
    }
    daily_spent_at(state.day_start_unix, state.daily_spent, proof_timestamp)
        .ok_or_else(|| error!(VerifierError::StaleProof))
}

/// Kurumun ilk ispatı: sayaç ispatın UTC gününde sıfırdan başlar.
pub fn open_operator_state(
    state: &mut Account<OperatorState>,
    institution: Pubkey,
    proof_timestamp: i64,
    bump: u8,
) {
    if is_new(state) {
        state.set_inner(OperatorState {
            institution,
            daily_spent: 0,
            day_start_unix: day_start(proof_timestamp),
            total_lifetime_payments: 0,
            bump,
        });
    }
}
