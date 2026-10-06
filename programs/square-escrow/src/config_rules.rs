//! Config kuralları: `init_config` ve `update_params` aynı doğrulamayı kullanır; arbitrator seti
//! kuralı `update_arbitrators`'la (BC-32) paylaşılır.

use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{EscrowParams, MAX_ARBITRATORS, MAX_KEEPER_FEE_BPS};

/// Challenge sınırları: `0 < min <= max`; `max` i64'e sığmalı (`challenge_end = now + period`).
/// Keeper ücreti en fazla `MAX_KEEPER_FEE_BPS` (ADR 0013). Dispute süresi pozitif (sıfır süre, her
/// dispute'un açıldığı anda lapse edilebilmesi demektir), ispat bekleme süresi negatif değil (ADR 0016).
pub fn validate_params(params: &EscrowParams) -> Result<()> {
    require!(
        params.min_challenge_period > 0
            && params.min_challenge_period <= params.max_challenge_period
            && i64::try_from(params.max_challenge_period).is_ok(),
        EscrowError::InvalidChallengePeriod
    );
    require!(
        params.keeper_fee_bps <= MAX_KEEPER_FEE_BPS,
        EscrowError::InvalidKeeperFee
    );
    require!(
        params.dispute_timeout_secs > 0 && params.proof_timeout_secs >= 0,
        EscrowError::InvalidDisputeTimeout
    );
    Ok(())
}

/// M-of-N arbitrator seti: en fazla `MAX_ARBITRATORS`, tekrar ve boş anahtar yok, `2 <= M <= N`.
/// Kullanılmayan slotlar `Pubkey::default()`.
pub fn arbitrator_slots(
    arbitrators: &[Pubkey],
    threshold: u8,
) -> Result<[Pubkey; MAX_ARBITRATORS]> {
    require!(
        arbitrators.len() <= MAX_ARBITRATORS,
        EscrowError::InvalidArbitratorSet
    );
    let distinct = arbitrators
        .iter()
        .enumerate()
        .all(|(i, key)| *key != Pubkey::default() && !arbitrators[..i].contains(key));
    require!(distinct, EscrowError::InvalidArbitratorSet);
    require!(
        threshold >= 2 && usize::from(threshold) <= arbitrators.len(),
        EscrowError::InvalidThreshold
    );
    let mut slots = [Pubkey::default(); MAX_ARBITRATORS];
    slots[..arbitrators.len()].copy_from_slice(arbitrators);
    Ok(slots)
}
