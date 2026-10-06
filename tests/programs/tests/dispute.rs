//! square_escrow uyuşmazlığı, policy'siz işler (BC-32, BC-33; ADR 0016): kurum challenge penceresinde
//! bond'la itiraz eder, M-of-N arbitrator oyu kararı kaydeder, `execute_resolution` herkesçe çağrılır ve
//! ödemeyi yapar; karar son tarihe kadar çıkmazsa `lapse_dispute` bond'u iade eder ve iş normal finalize
//! yoluna döner. Arbitrator seti aktif dispute sırasında değişebilir. Policy'li işlerin ispat kapısı ve
//! ispatsız bekleme başvurusu `dispute_gate.rs`'te.

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, ClaimStatus, DisputeResolution, JobStatus, ValidationOutcome,
    ValidationRecord, MAX_ARBITRATORS,
};
use square_escrow::{
    ArbitratorsUpdated, DisputeDecided, DisputeLapsed, DisputeRaised, DisputeResolved, DisputeVote,
    ReleaseVerified,
};
use square_program_tests::{anchor_error, cu, event, events};
use square_registry::ScreeningStatus;

const LAMPORTS: u64 = 1_000_000_000;
/// Kurumun başlangıç bakiyesi (`open_job`).
const INSTITUTION_FUNDS: u64 = 10 * AMOUNT;

/// Teslim edilmiş iş, kurum `MIN_BOND`'la itiraz etti.
fn disputed(w: &mut World) -> (Institution, Agent, Pubkey) {
    let (institution, agent, job) = w.delivered_job();
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise_dispute");
    (institution, agent, job)
}

#[test]
fn the_institution_disputes_inside_the_window_with_enough_bond() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();

    w.raise_dispute(&institution, &job, MIN_BOND - 1)
        .expect_err("bond alt sınırın altında")
        .assert_error(anchor_error(EscrowError::InsufficientBond));
    // Agent ya da başka biri kurum adına itiraz edemez.
    let other = Institution {
        key: agent.wallet.insecure_clone(),
        token_account: institution.token_account,
    };
    w.raise_dispute(&other, &job, MIN_BOND)
        .expect_err("kurum değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let challenge_end = w.job(&job).challenge_end;
    w.h.set_time(challenge_end - 1);
    let executed = w
        .raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise_dispute");
    cu::within("escrow.raise_dispute", &executed, 60_000);

    let state = w.job(&job);
    assert_eq!(state.status, JobStatus::Disputed);
    let d = state.dispute;
    assert_eq!(
        (d.challenger, d.bond, d.reason_hash, d.raised_at),
        (
            institution.key.pubkey(),
            MIN_BOND,
            REASON,
            challenge_end - 1
        )
    );
    assert_eq!(
        d.deadline,
        challenge_end - 1 + params().dispute_timeout_secs
    );
    assert_eq!(
        (d.approval_count, d.resolution, d.arbitrator_set_version),
        (0, DisputeResolution::Pending, 0)
    );
    assert_eq!(w.balance(&bond_address(&job)), Some(MIN_BOND));
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS - AMOUNT - MIN_BOND)
    );
    let raised: DisputeRaised = event(&executed);
    assert_eq!(
        (raised.job, raised.challenger, raised.bond, raised.deadline),
        (job, institution.key.pubkey(), MIN_BOND, d.deadline)
    );

    // Aktif dispute varken ikincisi açılmaz, iş de finalize edilmez.
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect_err("ikinci dispute")
        .assert_error(anchor_error(EscrowError::DisputeAlreadyActive));
    w.h.set_time(challenge_end);
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.finalize(&keeper, &job, settlement)
        .expect_err("dispute'taki iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn a_dispute_needs_a_delivered_job_inside_its_window() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.accepted_job();
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect_err("teslim edilmemiş iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    let mut w = World::new(true);
    let (institution, _agent, job) = w.delivered_job();
    w.h.set_time(w.job(&job).challenge_end);
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect_err("pencere kapandı")
        .assert_error(anchor_error(EscrowError::DisputeWindowClosed));
}

#[test]
fn m_of_n_arbitrators_decide_in_favor_of_the_agent() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    let panel: Vec<_> = w
        .panel
        .arbitrators
        .iter()
        .map(|k| k.insecure_clone())
        .collect();

    // Panel dışı imzacı oy veremez; `Pending` ya da escrow'u aşan bir Split oy değildir.
    let outsider = w.h.funded(LAMPORTS);
    w.vote(&outsider, &job, DisputeResolution::FavorAgent)
        .expect_err("arbitrator değil")
        .assert_error(anchor_error(EscrowError::NotArbitrator));
    w.vote(&panel[0], &job, DisputeResolution::Pending)
        .expect_err("karar değil")
        .assert_error(anchor_error(EscrowError::ResolutionMismatch));
    w.vote(
        &panel[0],
        &job,
        DisputeResolution::Split {
            agent_amount: AMOUNT + 1,
        },
    )
    .expect_err("escrow'dan fazla")
    .assert_error(anchor_error(EscrowError::InvalidSplitAmount));

    let first = w
        .vote(&panel[0], &job, DisputeResolution::FavorAgent)
        .expect("ilk oy");
    cu::within("escrow.resolve_dispute", &first, 30_000);
    let vote: DisputeVote = event(&first);
    assert_eq!(
        (
            vote.job,
            vote.arbitrator,
            vote.resolution,
            vote.approval_count
        ),
        (job, panel[0].pubkey(), DisputeResolution::FavorAgent, 1)
    );
    assert!(events::<DisputeDecided>(&first).is_empty(), "eşik 2");
    // Aynı arbitrator ikinci kez oy veremez; sonraki oylar ilk kararla aynı olmalı.
    w.h.advance(1);
    w.vote(&panel[0], &job, DisputeResolution::FavorAgent)
        .expect_err("ikinci oy")
        .assert_error(anchor_error(EscrowError::AlreadyVoted));
    w.vote(&panel[1], &job, DisputeResolution::FavorInstitution)
        .expect_err("farklı karar")
        .assert_error(anchor_error(EscrowError::ResolutionMismatch));

    // Karar yokken ödeme yapılmaz.
    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    w.execute(&caller, &job, settlement)
        .expect_err("karar yok")
        .assert_error(anchor_error(EscrowError::ResolutionNotDecided));

    let decided_at = w.h.now();
    let second = w
        .vote(&panel[2], &job, DisputeResolution::FavorAgent)
        .expect("eşik");
    let decided: DisputeDecided = event(&second);
    assert_eq!(
        (decided.job, decided.resolution),
        (job, DisputeResolution::FavorAgent)
    );
    let state = w.job(&job);
    assert_eq!(state.status, JobStatus::Resolved);
    assert_eq!(
        (
            state.dispute.approval_mask,
            state.dispute.approval_count,
            state.dispute.decided_at
        ),
        (0b101, 2, decided_at)
    );
    // Karara bağlanan dispute'ta oy yok.
    w.vote(&panel[1], &job, DisputeResolution::FavorAgent)
        .expect_err("karar verildi")
        .assert_error(anchor_error(EscrowError::NoActiveDispute));

    let vault_rent = w.h.lamports(&vault_address(&job));
    let bond_rent = w.h.lamports(&bond_address(&job));
    let rent_payer = state.rent_payer;
    let rent_before = w.h.lamports(&rent_payer);
    let executed = w
        .execute(&caller, &job, settlement)
        .expect("execute_resolution");
    cu::within("escrow.execute_resolution (gate yok)", &executed, 90_000);

    // Agent tarafı escrow'un tamamını (keeper ücreti yok) ve kurumun bond'unu alır.
    assert_eq!(
        w.balance(&settlement.payee_token_account),
        Some(AMOUNT + MIN_BOND)
    );
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS - AMOUNT - MIN_BOND)
    );
    assert_eq!(w.balance(&vault_address(&job)), None, "vault kapandı");
    assert_eq!(w.balance(&bond_address(&job)), None, "bond vault kapandı");
    let tx_fee = 2 * 5_000;
    assert_eq!(
        w.h.lamports(&rent_payer),
        rent_before + vault_rent + bond_rent - tx_fee
    );
    let settled = w.job(&job);
    assert_eq!(settled.status, JobStatus::Released);
    assert_eq!(settled.dispute.closed_at, w.h.now());

    let resolved: DisputeResolved = event(&executed);
    assert_eq!(
        (
            resolved.resolution,
            resolved.agent_side_amount,
            resolved.institution_refund,
            resolved.bond_to_agent_side,
            resolved.bond_returned
        ),
        (DisputeResolution::FavorAgent, AMOUNT, 0, MIN_BOND, 0)
    );
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (verified.payee, verified.net_amount, verified.release_proof),
        (agent.wallet.pubkey(), AMOUNT, None)
    );
    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(
        (
            reputation.jobs_completed,
            reputation.jobs_failed,
            reputation.jobs_disputed,
            reputation.total_earned
        ),
        (1, 0, 1, AMOUNT)
    );
    let validation: ValidationRecord = w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(validation.outcome, ValidationOutcome::NoGate);

    // Bir karar bir kez ödenir.
    let again = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &again.pubkey(), agent.wallet.pubkey());
    w.execute(&again, &job, settlement)
        .expect_err("ikinci execute")
        .assert_error(anchor_error(AnchorErrorCode::AccountNotInitialized));
}

#[test]
fn favor_institution_refunds_the_escrow_and_the_bond() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    w.decide(&job, DisputeResolution::FavorInstitution);

    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    // Agent tarafına ödeme yoksa payee'nin screening'i aranmaz.
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Flagged);
    let executed = w
        .execute(&caller, &job, settlement)
        .expect("execute_resolution");

    assert_eq!(w.balance(&settlement.payee_token_account), Some(0));
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS)
    );
    assert_eq!(w.job(&job).status, JobStatus::Refunded);
    let resolved: DisputeResolved = event(&executed);
    assert_eq!(
        (
            resolved.agent_side_amount,
            resolved.institution_refund,
            resolved.bond_to_agent_side,
            resolved.bond_returned
        ),
        (0, AMOUNT, 0, MIN_BOND)
    );
    assert!(events::<ReleaseVerified>(&executed).is_empty());
    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(
        (
            reputation.jobs_completed,
            reputation.jobs_failed,
            reputation.jobs_disputed,
            reputation.total_earned
        ),
        (0, 1, 1, 0)
    );
    let validation: ValidationRecord = w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (validation.outcome, validation.release_proof),
        (ValidationOutcome::NoPayout, None)
    );
}

#[test]
fn a_split_pays_the_agent_side_its_share_and_returns_the_bond() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    let share = AMOUNT / 4;
    w.decide(
        &job,
        DisputeResolution::Split {
            agent_amount: share,
        },
    );

    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    let executed = w
        .execute(&caller, &job, settlement)
        .expect("execute_resolution");

    assert_eq!(w.balance(&settlement.payee_token_account), Some(share));
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS - share)
    );
    assert_eq!(w.job(&job).status, JobStatus::Released);
    let resolved: DisputeResolved = event(&executed);
    assert_eq!(
        (
            resolved.agent_side_amount,
            resolved.institution_refund,
            resolved.bond_returned
        ),
        (share, AMOUNT - share, MIN_BOND)
    );
    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, share)
    );
}

#[test]
fn the_agent_side_must_be_screened_and_paid_on_its_own_account() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    w.decide(&job, DisputeResolution::FavorAgent);
    let caller = w.h.funded(LAMPORTS);

    // Kurumun token hesabı payee yerine verilemez.
    let mut wrong = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    wrong.payee_token_account = institution.token_account;
    w.execute(&caller, &job, wrong)
        .expect_err("payee'nin hesabı değil")
        .assert_error(anchor_error(EscrowError::AgentMismatch));

    // Payee'nin screening'i bayraklıysa ödeme bekler; temizlenince yapılır.
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Flagged);
    w.execute(&caller, &job, settlement)
        .expect_err("bayraklı payee")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    assert_eq!(w.job(&job).status, JobStatus::Resolved);
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
    w.execute(&caller, &job, settlement)
        .expect("execute_resolution");
}

#[test]
fn a_sold_receivable_routes_the_award_and_the_bond_to_the_buyer() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let buyer = w.buyer(CLAIM_PRICE);
    w.sell_claim(&agent, &job, &buyer);
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise_dispute");
    w.decide(&job, DisputeResolution::FavorAgent);

    let caller = w.h.funded(LAMPORTS);
    let to_agent = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    w.execute(&caller, &job, to_agent)
        .expect_err("alacak satıldı")
        .assert_error(anchor_error(EscrowError::ClaimListingRequired));
    let settlement = Settlement {
        payee: buyer.key.pubkey(),
        payee_token_account: buyer.token_account,
        ..to_agent
    };
    w.execute(&caller, &job, settlement)
        .expect("execute_resolution");
    assert_eq!(w.balance(&buyer.token_account), Some(AMOUNT + MIN_BOND));
    assert_eq!(w.claim(&job).status, ClaimStatus::Settled);
}

#[test]
fn a_refund_defaults_the_sold_receivable() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let buyer = w.buyer(CLAIM_PRICE);
    w.sell_claim(&agent, &job, &buyer);
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise_dispute");
    w.decide(&job, DisputeResolution::FavorInstitution);

    let caller = w.h.funded(LAMPORTS);
    let settlement = Settlement {
        payee: buyer.key.pubkey(),
        payee_token_account: buyer.token_account,
        ..w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey())
    };
    w.execute(&caller, &job, settlement)
        .expect("execute_resolution");
    assert_eq!(w.balance(&buyer.token_account), Some(0));
    assert_eq!(w.claim(&job).status, ClaimStatus::Defaulted);
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS)
    );
}

#[test]
fn without_a_decision_the_dispute_lapses_and_the_job_settles_normally() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    let panel: Vec<_> = w
        .panel
        .arbitrators
        .iter()
        .map(|k| k.insecure_clone())
        .collect();
    w.vote(&panel[0], &job, DisputeResolution::FavorInstitution)
        .expect("tek oy");
    let deadline = w.job(&job).dispute.deadline;
    let caller = w.h.funded(LAMPORTS);

    w.h.set_time(deadline - 1);
    w.lapse(&caller, &job, institution.token_account)
        .expect_err("son tarihten önce")
        .assert_error(anchor_error(EscrowError::DisputeNotExpired));

    // Son tarihte oy verilemez; dispute yalnızca lapse ile düşer.
    w.h.set_time(deadline);
    w.vote(&panel[1], &job, DisputeResolution::FavorInstitution)
        .expect_err("son tarih geçti")
        .assert_error(anchor_error(EscrowError::DisputeWindowClosed));

    // Bond'un hedefi kurumun hesabıdır.
    let stranger = w.buyer(0);
    w.lapse(&caller, &job, stranger.token_account)
        .expect_err("kurumun hesabı değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let executed = w
        .lapse(&caller, &job, institution.token_account)
        .expect("lapse_dispute");
    cu::within("escrow.lapse_dispute", &executed, 40_000);
    let lapsed: DisputeLapsed = event(&executed);
    assert_eq!((lapsed.job, lapsed.bond_refunded), (job, MIN_BOND));
    assert_eq!(
        w.balance(&institution.token_account),
        Some(INSTITUTION_FUNDS - AMOUNT)
    );
    assert_eq!(w.balance(&bond_address(&job)), None, "bond vault kapandı");
    let state = w.job(&job);
    assert_eq!(state.status, JobStatus::Delivered);
    assert!(state.dispute.lapsed);
    assert_eq!(state.dispute.closed_at, deadline);

    // İkinci lapse yok; kurum ikinci bir dispute açamaz.
    w.lapse(&caller, &job, institution.token_account)
        .expect_err("dispute yok")
        .assert_error(anchor_error(EscrowError::NoActiveDispute));
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect_err("işin dispute'u oldu")
        .assert_error(anchor_error(EscrowError::DisputeAlreadyRaised));

    // Fonlar kilitli kalmaz: iş normal finalize yolundan agent'a ödenir.
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    w.finalize(&caller, &job, settlement)
        .expect("finalize_payment");
    assert_eq!(w.job(&job).status, JobStatus::Released);
}

#[test]
fn arbitrator_sets_are_m_of_n_with_m_at_least_two() {
    let mut w = World::deployed(true);
    let admin = w.admin.pubkey();
    let keys = |n: usize| (0..n).map(|_| Pubkey::new_unique()).collect::<Vec<_>>();
    let cases = [
        (keys(3), 1, EscrowError::InvalidThreshold),
        (keys(3), 4, EscrowError::InvalidThreshold),
        (keys(1), 1, EscrowError::InvalidThreshold),
        (
            keys(MAX_ARBITRATORS + 1),
            2,
            EscrowError::InvalidArbitratorSet,
        ),
        (
            vec![Pubkey::default(), Pubkey::new_unique()],
            2,
            EscrowError::InvalidArbitratorSet,
        ),
    ];
    let admin_key = w.admin.insecure_clone();
    for (arbitrators, threshold, error) in cases.clone() {
        let ix = w.init_config_ix(&admin, w.usdc, arbitrators, threshold, params());
        w.h.send(&[ix], &[&admin_key])
            .expect_err("geçersiz set")
            .assert_error(anchor_error(error));
    }
    let duplicate = Pubkey::new_unique();
    let ix = w.init_config_ix(&admin, w.usdc, vec![duplicate, duplicate], 2, params());
    w.h.send(&[ix], &[&admin_key])
        .expect_err("tekrar eden üye")
        .assert_error(anchor_error(EscrowError::InvalidArbitratorSet));

    // Aynı kurallar `update_arbitrators`'ta.
    let mut w = World::new(true);
    for (arbitrators, threshold, error) in cases {
        w.update_arbitrators(arbitrators, threshold)
            .expect_err("geçersiz set")
            .assert_error(anchor_error(error));
    }
    let seven = keys(MAX_ARBITRATORS);
    let executed = w
        .update_arbitrators(seven.clone(), 5)
        .expect("7 üyeli set, M = 5");
    let updated: ArbitratorsUpdated = event(&executed);
    assert_eq!(
        (
            updated.arbitrators,
            updated.threshold,
            updated.arbitrator_set_version
        ),
        (seven.clone(), 5, 1)
    );
    let config = w.config();
    assert_eq!(
        (
            config.arbitrator_count,
            config.threshold,
            config.arbitrator_set_version
        ),
        (7, 5, 1)
    );
    assert_eq!(config.arbitrators.to_vec(), seven);

    // Yalnızca admin.
    let intruder = w.h.funded(LAMPORTS);
    let ix = w.update_arbitrators_ix(&intruder.pubkey(), keys(3), 2);
    w.h.send(&[ix], &[&intruder])
        .expect_err("admin değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));
}

#[test]
fn changing_the_set_during_a_dispute_restarts_the_tally_without_breaking_it() {
    let mut w = World::new(true);
    let (institution, agent, job) = disputed(&mut w);
    let old: Vec<_> = w
        .panel
        .arbitrators
        .iter()
        .map(|k| k.insecure_clone())
        .collect();
    w.vote(&old[0], &job, DisputeResolution::FavorInstitution)
        .expect("eski setin oyu");
    let deadline = w.job(&job).dispute.deadline;

    // Yeni set: eski üyelerden biri kalır (old[1]), iki yeni üye, M = 3.
    let new_members = Panel::new(2, 0);
    let mut members = vec![old[1].pubkey()];
    members.extend(new_members.keys());
    w.update_arbitrators(members, 3)
        .expect("update_arbitrators");

    // Setten çıkan arbitrator oy veremez.
    w.vote(&old[0], &job, DisputeResolution::FavorAgent)
        .expect_err("setten çıktı")
        .assert_error(anchor_error(EscrowError::NotArbitrator));

    // İlk oy sayımı yeni setle baştan başlatır: eski oy ve eski karar düşer, son tarih aynı kalır.
    let executed = w
        .vote(&old[1], &job, DisputeResolution::FavorAgent)
        .expect("yeni setin ilk oyu");
    assert_eq!(event::<DisputeVote>(&executed).approval_count, 1);
    let d = w.job(&job).dispute;
    assert_eq!(
        (
            d.arbitrator_set_version,
            d.approval_mask,
            d.approval_count,
            d.deadline
        ),
        (1, 0b1, 1, deadline)
    );
    w.vote(
        &new_members.arbitrators[0],
        &job,
        DisputeResolution::FavorAgent,
    )
    .expect("ikinci oy");
    assert_eq!(w.job(&job).status, JobStatus::Disputed, "M = 3");
    w.vote(
        &new_members.arbitrators[1],
        &job,
        DisputeResolution::FavorAgent,
    )
    .expect("eşik");
    assert_eq!(w.job(&job).status, JobStatus::Resolved);

    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    w.execute(&caller, &job, settlement)
        .expect("execute_resolution");
    assert_eq!(
        w.balance(&settlement.payee_token_account),
        Some(AMOUNT + MIN_BOND)
    );
}

#[test]
fn dispute_timeouts_are_validated() {
    let mut w = World::new(true);
    let mut p = params();
    p.dispute_timeout_secs = 0;
    let admin = w.admin.insecure_clone();
    let ix = w.update_params_ix(&admin.pubkey(), p);
    w.h.send(&[ix], &[&admin])
        .expect_err("sıfır dispute süresi")
        .assert_error(anchor_error(EscrowError::InvalidDisputeTimeout));
    let mut p = params();
    p.proof_timeout_secs = -1;
    let ix = w.update_params_ix(&admin.pubkey(), p);
    w.h.send(&[ix], &[&admin])
        .expect_err("negatif ispat süresi")
        .assert_error(anchor_error(EscrowError::InvalidDisputeTimeout));
}
