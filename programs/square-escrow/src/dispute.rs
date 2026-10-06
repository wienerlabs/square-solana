//! Dispute kuralları (BC-32, BC-33; ADR 0016): bond alt sınırı, son tarih, M-of-N oy sayımı ve aktif
//! dispute'ta arbitrator seti değişimi. Talimatlar (`raise_dispute`, `escalate_missing_proof`,
//! `resolve_dispute`, `execute_resolution`, `lapse_dispute`) kararları buradan alır; saf fonksiyonlar
//! birim testlidir.

use anchor_lang::prelude::*;
use square_common::constants::BPS_DENOMINATOR;

use crate::errors::EscrowError;
use crate::state::{
    DisputeInfo, DisputeResolution, EscrowConfig, EscrowParams, Job, JobStatus, SettlementRail,
};

/// Dispute yalnızca teslim edilmiş işte açılır; açık ya da karara bağlanmış dispute'un üstüne açılmaz.
pub fn require_can_open(job: &Job) -> Result<()> {
    // Fiat işte escrow'da tutulan bir ödeme yoktur, dispute ödeme taşıyamaz (ADR 0024).
    require!(
        job.rail == SettlementRail::Escrow,
        EscrowError::RailMismatch
    );
    match job.status {
        JobStatus::Delivered => Ok(()),
        JobStatus::Disputed | JobStatus::Resolved => err!(EscrowError::DisputeAlreadyActive),
        _ => err!(EscrowError::InvalidStatus),
    }
}

/// `max(amount × min_bond_bps / 10 000, min_bond_absolute)`, aşağı yuvarlanır.
pub fn min_bond(amount: u64, params: &EscrowParams) -> Result<u64> {
    let relative =
        u128::from(amount) * u128::from(params.min_bond_bps) / u128::from(BPS_DENOMINATOR);
    let relative = u64::try_from(relative).map_err(|_| error!(EscrowError::MathOverflow))?;
    Ok(relative.max(params.min_bond_absolute))
}

/// `raised_at + dispute_timeout_secs`.
pub fn deadline(raised_at: i64, params: &EscrowParams) -> Result<i64> {
    raised_at
        .checked_add(params.dispute_timeout_secs)
        .ok_or_else(|| error!(EscrowError::MathOverflow))
}

/// Oyun dayandığı arbitrator: `config.arbitrators[..arbitrator_count]` içindeki sırası.
pub fn arbitrator_index(config: &EscrowConfig, arbitrator: &Pubkey) -> Result<usize> {
    config.arbitrators[..usize::from(config.arbitrator_count)]
        .iter()
        .position(|key| key == arbitrator)
        .ok_or_else(|| error!(EscrowError::NotArbitrator))
}

/// Oy kararın kendisi olmalı (`Pending` değil); `Split`'te agent tarafı escrow'u aşamaz.
pub fn validate_vote(resolution: &DisputeResolution, amount: u64) -> Result<()> {
    match resolution {
        DisputeResolution::Pending => err!(EscrowError::ResolutionMismatch),
        DisputeResolution::Split { agent_amount } => {
            require!(*agent_amount <= amount, EscrowError::InvalidSplitAmount);
            Ok(())
        }
        DisputeResolution::FavorAgent | DisputeResolution::FavorInstitution => Ok(()),
    }
}

/// Bir oyun sayıma etkisi. Döndürdüğü değer eşiğe ulaşılıp ulaşılmadığıdır.
///
/// Aktif dispute'ta set değişimi (ADR 0016): oy, oy anındaki sete göre sayılır. Dispute'un saklı
/// `arbitrator_set_version`'ı config'ten eskiyse önceki oylar düşer (bit maskesi eski setin
/// sıralarına göredir, yeni sette başka anahtarlara denk gelir) ve sayım yeni setle baştan başlar.
/// Dispute bozulmaz: son tarihi ve bond'u aynı kalır, karar verilmezse `lapse_dispute` ile düşer.
pub fn tally(
    dispute: &mut DisputeInfo,
    config: &EscrowConfig,
    index: usize,
    resolution: DisputeResolution,
) -> Result<bool> {
    if dispute.arbitrator_set_version != config.arbitrator_set_version {
        dispute.arbitrator_set_version = config.arbitrator_set_version;
        dispute.approval_mask = 0;
        dispute.approval_count = 0;
        dispute.resolution = DisputeResolution::Pending;
    }
    let bit = 1u8 << index;
    require!(dispute.approval_mask & bit == 0, EscrowError::AlreadyVoted);
    if dispute.resolution == DisputeResolution::Pending {
        dispute.resolution = resolution;
    } else {
        require!(
            dispute.resolution == resolution,
            EscrowError::ResolutionMismatch
        );
    }
    dispute.approval_mask |= bit;
    dispute.approval_count += 1;
    Ok(dispute.approval_count >= config.threshold)
}

/// Kararın settlement'ı: agent tarafına giden escrow tutarı ve bond'un agent tarafına kesilip
/// kesilmediği.
pub fn agent_side(resolution: &DisputeResolution, amount: u64) -> Result<(u64, bool)> {
    match resolution {
        DisputeResolution::Pending => err!(EscrowError::ResolutionNotDecided),
        DisputeResolution::FavorAgent => Ok((amount, true)),
        DisputeResolution::FavorInstitution => Ok((0, false)),
        DisputeResolution::Split { agent_amount } => {
            require!(*agent_amount <= amount, EscrowError::InvalidSplitAmount);
            Ok((*agent_amount, false))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MAX_ARBITRATORS, MAX_KEEPER_FEE_BPS};

    fn params() -> EscrowParams {
        EscrowParams {
            min_challenge_period: 60,
            max_challenge_period: 86_400,
            min_bond_bps: 500,
            min_bond_absolute: 1_000,
            keeper_fee_bps: MAX_KEEPER_FEE_BPS,
            proof_timeout_secs: 86_400,
            dispute_timeout_secs: 3 * 86_400,
            travel_rule_threshold: 0,
        }
    }

    fn config(n: usize, threshold: u8, version: u32) -> EscrowConfig {
        let mut arbitrators = [Pubkey::default(); MAX_ARBITRATORS];
        for (i, slot) in arbitrators.iter_mut().enumerate().take(n) {
            *slot = Pubkey::new_from_array([i as u8 + 1; 32]);
        }
        EscrowConfig {
            admin: Pubkey::default(),
            settlement_mint: Pubkey::default(),
            registry_program: Pubkey::default(),
            policy_program: Pubkey::default(),
            verifier_program: Pubkey::default(),
            arbitrators,
            arbitrator_count: n as u8,
            threshold,
            arbitrator_set_version: version,
            params: params(),
            bump: 0,
        }
    }

    #[test]
    fn bond_is_the_larger_of_the_relative_and_absolute_minimum() {
        assert_eq!(min_bond(10_000, &params()).unwrap(), 1_000);
        assert_eq!(min_bond(1_000_000, &params()).unwrap(), 50_000);
        assert_eq!(min_bond(u64::MAX, &params()).unwrap(), u64::MAX / 20);
    }

    #[test]
    fn only_active_slots_are_arbitrators() {
        let config = config(3, 2, 0);
        assert_eq!(
            arbitrator_index(&config, &config.arbitrators[2]).unwrap(),
            2
        );
        assert!(arbitrator_index(&config, &Pubkey::new_from_array([4; 32])).is_err());
        assert!(arbitrator_index(&config, &Pubkey::default()).is_err());
    }

    #[test]
    fn m_votes_decide_and_nobody_votes_twice() {
        let config = config(3, 2, 0);
        let mut dispute = DisputeInfo::default();
        let favor = DisputeResolution::FavorAgent;
        assert!(!tally(&mut dispute, &config, 0, favor).unwrap());
        assert!(tally(&mut dispute, &config, 0, favor).is_err());
        assert!(tally(
            &mut dispute,
            &config,
            1,
            DisputeResolution::FavorInstitution
        )
        .is_err());
        assert!(tally(&mut dispute, &config, 2, favor).unwrap());
        assert_eq!(dispute.approval_mask, 0b101);
        assert_eq!(dispute.approval_count, 2);
    }

    #[test]
    fn a_new_arbitrator_set_restarts_the_tally() {
        let mut dispute = DisputeInfo::default();
        let favor = DisputeResolution::Split { agent_amount: 5 };
        assert!(!tally(&mut dispute, &config(3, 2, 0), 0, favor).unwrap());
        // Set değişti: eski oy (sıra 0) sayılmaz, karar da serbest kalır.
        let next = config(4, 3, 1);
        let other = DisputeResolution::FavorInstitution;
        assert!(!tally(&mut dispute, &next, 0, other).unwrap());
        assert_eq!(dispute.arbitrator_set_version, 1);
        assert_eq!((dispute.approval_mask, dispute.approval_count), (0b1, 1));
        assert!(!tally(&mut dispute, &next, 1, other).unwrap());
        assert!(tally(&mut dispute, &next, 3, other).unwrap());
    }

    #[test]
    fn votes_and_settlements_respect_the_escrowed_amount() {
        assert!(validate_vote(&DisputeResolution::Pending, 10).is_err());
        assert!(validate_vote(&DisputeResolution::Split { agent_amount: 11 }, 10).is_err());
        assert!(validate_vote(&DisputeResolution::Split { agent_amount: 10 }, 10).is_ok());
        assert_eq!(
            agent_side(&DisputeResolution::FavorAgent, 10).unwrap(),
            (10, true)
        );
        assert_eq!(
            agent_side(&DisputeResolution::FavorInstitution, 10).unwrap(),
            (0, false)
        );
        assert_eq!(
            agent_side(&DisputeResolution::Split { agent_amount: 4 }, 10).unwrap(),
            (4, false)
        );
        assert!(agent_side(&DisputeResolution::Pending, 10).is_err());
    }

    #[test]
    fn deadline_overflow_is_an_error() {
        let mut p = params();
        assert_eq!(deadline(100, &p).unwrap(), 100 + 3 * 86_400);
        p.dispute_timeout_secs = i64::MAX;
        assert!(deadline(1, &p).is_err());
    }
}
