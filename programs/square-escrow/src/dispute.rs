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

/// Bir oyun sayıma etkisi.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoteOutcome {
    /// Oy bekleyen öneriyi onayladı ya da yeni öneriyi açtı; `decided` eşiğe ulaşıldı mı.
    Approved { decided: bool },
    /// Oy bekleyen öneriden farklıydı: ret sayıldı. `reset`: retler eşiği imkânsız kıldı, öneri ve maskeler
    /// sıfırlandı; sonraki oy yeni bir öneri açar (ADR 0028 madde 4).
    Rejected { rejections: u8, reset: bool },
}

/// Oyu sayar. Bekleyen öneri yoksa oy öneriyi açar; aynı karar onaydır, farklı karar ret. Retler
/// aktif arbitrator sayısından çıkınca eşik (`threshold`) imkânsızlaşırsa öneri düşer: tek bir üye ne
/// kararı dayatabilir ne de engelleyebilir (ADR 0028, ADR 0016 Karar 1'in yerine).
///
/// Aktif dispute'ta set değişimi (ADR 0016): oy, oy anındaki sete göre sayılır. Dispute'un saklı
/// `arbitrator_set_version`'ı config'ten eskiyse önceki oylar ve retler düşer (bit maskeleri eski setin
/// sıralarına göredir, yeni sette başka anahtarlara denk gelir) ve sayım yeni setle baştan başlar.
/// Dispute bozulmaz: son tarihi ve bond'u aynı kalır, karar verilmezse `lapse_dispute` ile düşer.
pub fn tally(
    dispute: &mut DisputeInfo,
    rejection_mask: &mut u8,
    config: &EscrowConfig,
    index: usize,
    resolution: DisputeResolution,
) -> Result<VoteOutcome> {
    if dispute.arbitrator_set_version != config.arbitrator_set_version {
        dispute.arbitrator_set_version = config.arbitrator_set_version;
        reset_proposal(dispute, rejection_mask);
    }
    let bit = 1u8 << index;
    require!(
        (dispute.approval_mask | *rejection_mask) & bit == 0,
        EscrowError::AlreadyVoted
    );
    if dispute.resolution == DisputeResolution::Pending || dispute.resolution == resolution {
        dispute.resolution = resolution;
        dispute.approval_mask |= bit;
        dispute.approval_count += 1;
        return Ok(VoteOutcome::Approved {
            decided: dispute.approval_count >= config.threshold,
        });
    }
    *rejection_mask |= bit;
    let rejections = rejection_mask.count_ones() as u8;
    let reachable = config.arbitrator_count.saturating_sub(rejections);
    let reset = reachable < config.threshold;
    if reset {
        reset_proposal(dispute, rejection_mask);
    }
    Ok(VoteOutcome::Rejected { rejections, reset })
}

fn reset_proposal(dispute: &mut DisputeInfo, rejection_mask: &mut u8) {
    dispute.approval_mask = 0;
    dispute.approval_count = 0;
    dispute.resolution = DisputeResolution::Pending;
    *rejection_mask = 0;
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
        let mut rejections = 0u8;
        let favor = DisputeResolution::FavorAgent;
        let approved = |decided| VoteOutcome::Approved { decided };
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 0, favor).unwrap(),
            approved(false)
        );
        assert!(tally(&mut dispute, &mut rejections, &config, 0, favor).is_err());
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 2, favor).unwrap(),
            approved(true)
        );
        assert_eq!(dispute.approval_mask, 0b101);
        assert_eq!(dispute.approval_count, 2);
    }

    #[test]
    fn a_different_vote_rejects_and_enough_rejections_reset_the_proposal() {
        // 3 arbitrator, eşik 2: ilk oy öneri açar; iki ret öneriyi eşiğe ulaşamaz kılar ve düşürür.
        let config = config(3, 2, 0);
        let mut dispute = DisputeInfo::default();
        let mut rejections = 0u8;
        let favor = DisputeResolution::FavorAgent;
        let institution = DisputeResolution::FavorInstitution;
        tally(&mut dispute, &mut rejections, &config, 0, favor).unwrap();
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 1, institution).unwrap(),
            VoteOutcome::Rejected {
                rejections: 1,
                reset: false
            }
        );
        // Ret veren aynı öneriye yeniden oy veremez.
        assert!(tally(&mut dispute, &mut rejections, &config, 1, favor).is_err());
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 2, institution).unwrap(),
            VoteOutcome::Rejected {
                rejections: 2,
                reset: true
            }
        );
        assert_eq!(dispute.resolution, DisputeResolution::Pending);
        assert_eq!(
            (dispute.approval_mask, dispute.approval_count, rejections),
            (0, 0, 0)
        );
        // Yeni öneri: herkes yeniden oy verebilir, eşik iki onayla dolar.
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 1, institution).unwrap(),
            VoteOutcome::Approved { decided: false }
        );
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 2, institution).unwrap(),
            VoteOutcome::Approved { decided: true }
        );
    }

    #[test]
    fn one_rejection_cannot_block_a_proposal_that_can_still_pass() {
        // 4 arbitrator, eşik 3: tek ret öneriyi düşürmez, kalan üç onay kararı verir.
        let config = config(4, 3, 0);
        let mut dispute = DisputeInfo::default();
        let mut rejections = 0u8;
        let split = DisputeResolution::Split { agent_amount: 7 };
        tally(&mut dispute, &mut rejections, &config, 0, split).unwrap();
        assert_eq!(
            tally(
                &mut dispute,
                &mut rejections,
                &config,
                3,
                DisputeResolution::FavorAgent
            )
            .unwrap(),
            VoteOutcome::Rejected {
                rejections: 1,
                reset: false
            }
        );
        tally(&mut dispute, &mut rejections, &config, 1, split).unwrap();
        assert_eq!(
            tally(&mut dispute, &mut rejections, &config, 2, split).unwrap(),
            VoteOutcome::Approved { decided: true }
        );
    }

    #[test]
    fn a_new_arbitrator_set_restarts_the_tally() {
        let mut dispute = DisputeInfo::default();
        let mut rejections = 0u8;
        let favor = DisputeResolution::Split { agent_amount: 5 };
        tally(&mut dispute, &mut rejections, &config(3, 2, 0), 0, favor).unwrap();
        tally(
            &mut dispute,
            &mut rejections,
            &config(3, 2, 0),
            1,
            DisputeResolution::FavorAgent,
        )
        .unwrap();
        assert_eq!(rejections, 0b10);
        // Set değişti: eski oy ve ret (sıra 0 ve 1) sayılmaz, karar da serbest kalır.
        let next = config(4, 3, 1);
        let other = DisputeResolution::FavorInstitution;
        assert_eq!(
            tally(&mut dispute, &mut rejections, &next, 0, other).unwrap(),
            VoteOutcome::Approved { decided: false }
        );
        assert_eq!(dispute.arbitrator_set_version, 1);
        assert_eq!(
            (dispute.approval_mask, dispute.approval_count, rejections),
            (0b1, 1, 0)
        );
        tally(&mut dispute, &mut rejections, &next, 1, other).unwrap();
        assert_eq!(
            tally(&mut dispute, &mut rejections, &next, 3, other).unwrap(),
            VoteOutcome::Approved { decided: true }
        );
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
