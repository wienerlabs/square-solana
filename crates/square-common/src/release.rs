//! Release ispatının tazeliği ve günlük sayaç (ADR 0012, program arayüzü §4). Verifier ispatı bağlarken
//! sayacı ispat anının UTC gününe göre okur ([`daily_spent_at`]); escrow release'te ispatı
//! [`check_fresh`]'ten geçirir ve verifier `record_release`'te sayacı ilerletmeden önce aynı kuralı uygular.
//!
//! İspat, release'in zincirde yapılacağı hâline bağlıdır: payee, net tutar, mint ve kurumun o UTC
//! günündeki sayacı. Bunlardan biri değişirse ya da release ispatın gününden başka bir günde yapılırsa
//! ispat bayattır; kurum yenisini bağlar, escrow o zamana kadar bekler.

use anchor_lang::prelude::Pubkey;

use crate::contract::square_verifier_contract::accounts::{OperatorState, ReleaseProof};
use crate::time::day_start;

/// `OperatorState`'in `at` anındaki etkin sayacı: durum aynı UTC gününe aitse `daily_spent`, daha eski bir
/// güne aitse 0 (gün dönümü). Durum `at`'ın gününden yeniyse `None`: `at` için sayaç artık bilinemez.
pub const fn daily_spent_at(day_start_unix: i64, daily_spent: u64, at: i64) -> Option<u64> {
    let day = day_start(at);
    if day_start_unix == day {
        Some(daily_spent)
    } else if day_start_unix < day {
        Some(0)
    } else {
        None
    }
}

/// Ret kodunun bitleri (release-circuit.md §3).
pub mod refusal {
    pub const PER_TX: u16 = 1;
    pub const DAILY_PRIVATE: u16 = 2;
    pub const MINT_NOT_ALLOWED: u16 = 4;
    pub const PAYEE_BLOCKED: u16 = 8;
    pub const CATEGORY_NOT_ALLOWED: u16 = 16;
    pub const OUTSIDE_TIME_WINDOW: u16 = 32;
    pub const DAILY_CEILING: u16 = 64;

    /// Release'in kendisinden gelen, zamanla değişmeyen sebepler: tutar, mint ve payee job'dan ve
    /// alacaktan, tavan ve listeler job'un policy anlık görüntüsünden gelir.
    pub const PERMANENT: u16 = PER_TX | MINT_NOT_ALLOWED | PAYEE_BLOCKED;
    /// Günlük tavanlar: sayaç 0 iken çiğneniyorsa net tutar tek başına tavanı aşar, kalıcıdır; değilse
    /// sayaç gece yarısı sıfırlanınca geçebilir.
    pub const DAILY: u16 = DAILY_PRIVATE | DAILY_CEILING;
}

/// Ret, escrow'u kuruma iade edecek kesin bir karar mı (ADR 0013). Kalıcı bir sebep yoksa ret
/// geçicidir (günlük sayaç, zaman penceresi) ya da tamamen kurumun beyanına bağlıdır (kategori): escrow
/// bekler, kurum uyumlu bir ispat bağlayınca ödenir.
pub const fn is_final_refusal(refusal_code: u16, daily_spent_before: u64) -> bool {
    refusal_code & refusal::PERMANENT != 0
        || (daily_spent_before == 0 && refusal_code & refusal::DAILY != 0)
}

/// Release'in zincirde yapılacağı hâli: escrow kendi hesaplarından türetir.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReleaseFacts {
    /// Satılmış alacakta alıcı, değilse `Job.agent_wallet`.
    pub payee: Pubkey,
    /// Payee'nin alacağı tutar (keeper ücreti ya da dispute kararı sonrası).
    pub net_amount: u64,
    pub mint: Pubkey,
}

/// İspatın neden bayat olduğu. Escrow `StaleReleaseProof`, verifier `StaleProof` döner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Staleness {
    Payee,
    NetAmount,
    Mint,
    /// Release, ispatın değerlendirildiği UTC gününde değil.
    Day,
    /// Kurumun o günkü sayacı ispatın bağlandığı değerden farklı (araya başka bir release girdi).
    DailyCounter,
}

/// `proof`, `now` anındaki release için hâlâ geçerli mi (ADR 0012).
pub fn check_fresh(
    proof: &ReleaseProof,
    operator_state: &OperatorState,
    facts: &ReleaseFacts,
    now: i64,
) -> Result<(), Staleness> {
    if proof.payee != facts.payee {
        return Err(Staleness::Payee);
    }
    if proof.net_amount != facts.net_amount {
        return Err(Staleness::NetAmount);
    }
    if proof.mint != facts.mint {
        return Err(Staleness::Mint);
    }
    if day_start(proof.proof_timestamp) != day_start(now) {
        return Err(Staleness::Day);
    }
    match daily_spent_at(
        operator_state.day_start_unix,
        operator_state.daily_spent,
        now,
    ) {
        Some(spent) if spent == proof.daily_spent_before => Ok(()),
        _ => Err(Staleness::DailyCounter),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::SECONDS_PER_DAY;
    use crate::contract::square_verifier_contract::types::ReleaseVerdict;

    const NOW: i64 = 1_790_000_000;
    const DAY: i64 = 1_789_948_800;

    fn key(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    fn proof(daily_spent_before: u64, proof_timestamp: i64) -> ReleaseProof {
        ReleaseProof {
            job: key(1),
            institution: key(2),
            policy: key(3),
            payee: key(4),
            net_amount: 25_000_000,
            mint: key(5),
            daily_spent_before,
            proof_timestamp,
            verdict: ReleaseVerdict::Compliant,
            refusal_code: 0,
            consumed: false,
            bump: 255,
        }
    }

    fn state(day_start_unix: i64, daily_spent: u64) -> OperatorState {
        OperatorState {
            institution: key(2),
            daily_spent,
            day_start_unix,
            total_lifetime_payments: 1,
            bump: 254,
        }
    }

    fn facts() -> ReleaseFacts {
        ReleaseFacts {
            payee: key(4),
            net_amount: 25_000_000,
            mint: key(5),
        }
    }

    #[test]
    fn the_counter_rolls_over_at_utc_midnight() {
        assert_eq!(daily_spent_at(DAY, 40, NOW), Some(40));
        assert_eq!(daily_spent_at(DAY - SECONDS_PER_DAY, 40, NOW), Some(0));
        assert_eq!(daily_spent_at(DAY + SECONDS_PER_DAY, 40, NOW), None);
        assert_eq!(daily_spent_at(DAY, 40, DAY + SECONDS_PER_DAY - 1), Some(40));
        assert_eq!(daily_spent_at(DAY, 40, DAY + SECONDS_PER_DAY), Some(0));
    }

    #[test]
    fn a_proof_for_this_release_and_counter_is_fresh() {
        assert_eq!(
            check_fresh(&proof(40, NOW), &state(DAY, 40), &facts(), NOW + 60),
            Ok(())
        );
        // Sayaç eski güne aitse etkin değer 0: dün dolmuş sayaç bugünkü ispatı bayatlatmaz.
        assert_eq!(
            check_fresh(
                &proof(0, NOW),
                &state(DAY - SECONDS_PER_DAY, 900),
                &facts(),
                NOW
            ),
            Ok(())
        );
    }

    #[test]
    fn a_changed_payee_amount_or_mint_makes_it_stale() {
        let cases = [
            (
                ReleaseFacts {
                    payee: key(9),
                    ..facts()
                },
                Staleness::Payee,
            ),
            (
                ReleaseFacts {
                    net_amount: 1,
                    ..facts()
                },
                Staleness::NetAmount,
            ),
            (
                ReleaseFacts {
                    mint: key(9),
                    ..facts()
                },
                Staleness::Mint,
            ),
        ];
        for (facts, expected) in cases {
            assert_eq!(
                check_fresh(&proof(40, NOW), &state(DAY, 40), &facts, NOW),
                Err(expected)
            );
        }
    }

    #[test]
    fn only_a_permanent_refusal_is_final() {
        use refusal::*;
        for code in [
            PER_TX,
            MINT_NOT_ALLOWED,
            PAYEE_BLOCKED,
            PER_TX | OUTSIDE_TIME_WINDOW,
        ] {
            assert!(is_final_refusal(code, 40), "{code}");
        }
        // Sayaç 0 iken günlük tavanı aşan net tek başına tavanı aşar.
        assert!(is_final_refusal(DAILY_CEILING, 0));
        assert!(is_final_refusal(DAILY_PRIVATE, 0));
        // Kurumun zamanlamasına ya da beyanına bağlı sebepler tek başına iade etmez.
        for code in [
            DAILY_CEILING,
            DAILY_PRIVATE,
            OUTSIDE_TIME_WINDOW,
            CATEGORY_NOT_ALLOWED,
            CATEGORY_NOT_ALLOWED | DAILY_CEILING | OUTSIDE_TIME_WINDOW,
        ] {
            assert!(!is_final_refusal(code, 40), "{code}");
        }
        assert!(!is_final_refusal(CATEGORY_NOT_ALLOWED, 0));
        assert!(!is_final_refusal(OUTSIDE_TIME_WINDOW, 0));
        assert!(!is_final_refusal(0, 0));
    }

    #[test]
    fn another_release_of_the_day_or_a_new_day_makes_it_stale() {
        assert_eq!(
            check_fresh(&proof(0, NOW), &state(DAY, 40), &facts(), NOW),
            Err(Staleness::DailyCounter)
        );
        // Gün değişti: sayaç 0'a döner ama ispat dünün sayacına ve saatine göre yapıldı.
        assert_eq!(
            check_fresh(
                &proof(0, NOW),
                &state(DAY, 0),
                &facts(),
                DAY + SECONDS_PER_DAY
            ),
            Err(Staleness::Day)
        );
        // Durum ispatın gününden yeni: sayaç o gün için bilinemez.
        assert_eq!(
            check_fresh(
                &proof(0, NOW),
                &state(DAY + SECONDS_PER_DAY, 0),
                &facts(),
                NOW
            ),
            Err(Staleness::DailyCounter)
        );
    }
}
