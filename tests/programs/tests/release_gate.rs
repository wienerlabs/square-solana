//! square_escrow `finalize_payment`'ın ispat kapısı (BC-24; BC-21'in release tarafı; ADR 0012, ADR 0013):
//! policy'li işte ispat yoksa escrow bekler; uyumlu ve taze ispat payee'ye öder ve verifier'ın sayacını
//! ilerletir; kesin ret neti kuruma iade eder; geçici ya da kurumun beyanına bağlı ret beklemeye döner;
//! bayat ve sahte ispat geçmez. İspatlar gerçek Groth16 ispatlarıdır (`release_world`).

mod escrow_world;
mod release_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use release_world::*;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, ClaimStatus, JobStatus, ValidationOutcome, ValidationRecord,
};
use square_escrow::{Finalized, ReleaseRefused, ReleaseVerified, ValidationRecorded};
use square_program_tests::{anchor_error, cu, event, events};
use square_verifier::ReleaseRecorded;

const LAMPORTS: u64 = 1_000_000_000;

fn fee(amount: u64) -> u64 {
    amount * 50 / 10_000
}

/// Teslim edilmiş `spec` işi, ispatların anında; keeper ve agent'a ödenecek settlement.
fn ready(r: &mut ReleaseWorld, spec: &str) -> (Pubkey, Keypair, Settlement) {
    let job = r.delivered_job(spec);
    r.w.h.set_time(r.proof_time());
    let keeper = r.w.h.funded(LAMPORTS);
    let payee = r.agent.wallet.pubkey();
    let settlement = r.settlement(&keeper, payee);
    (job, keeper, settlement)
}

#[test]
fn a_policy_job_waits_without_a_proof() {
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    // İspat hesabı geçilmiş ama başlatılmamış, ya da hiç geçilmemiş.
    r.finalize(&keeper, &job, settlement)
        .expect_err("bağlanmış ispat yok")
        .assert_error(anchor_error(EscrowError::ProofRequired));
    let ix = r.w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    r.w.h
        .send(&[ix], &[&keeper])
        .expect_err("kapı hesapları yok")
        .assert_error(anchor_error(EscrowError::ProofRequired));
    assert_eq!(r.w.job(&job).status, JobStatus::Delivered, "escrow bekler");
    assert_eq!(r.w.balance(&vault_address(&job)), Some(r.amount("a")));
}

#[test]
fn a_compliant_fresh_proof_pays_the_agent_and_advances_the_counter() {
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    let p = r.proof("compliant");
    r.bind(&job, &p).expect("set_compliance_proof");

    let executed = r
        .finalize(&keeper, &job, settlement)
        .expect("finalize_payment");
    cu::within(
        "escrow.finalize_payment (uyumlu ispat, record_release CPI)",
        &executed,
        150_000,
    );
    let amount = r.amount("a");
    assert_eq!(p.net_amount, amount - fee(amount));
    assert_eq!(
        r.w.balance(&settlement.payee_token_account),
        Some(p.net_amount)
    );
    assert_eq!(
        r.w.balance(&settlement.keeper_token_account),
        Some(fee(amount))
    );
    assert_eq!(r.w.job(&job).status, JobStatus::Released);
    // Verifier'ın CPI'ı: ispat tüketildi, sayaç net kadar ilerledi.
    assert!(r.release_proof(&job).consumed);
    assert_eq!(r.operator_state().daily_spent, p.net_amount);
    let recorded: ReleaseRecorded = event(&executed);
    assert_eq!((recorded.job, recorded.net_amount), (job, p.net_amount));

    let proof_address = release_proof_address(&job);
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (verified.payee, verified.net_amount, verified.release_proof),
        (r.agent.wallet.pubkey(), p.net_amount, Some(proof_address))
    );
    let validation: ValidationRecord = r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (validation.outcome, validation.refusal_code),
        (ValidationOutcome::Verified, 0)
    );
    assert_eq!(
        (validation.policy, validation.release_proof),
        (Some(r.policy.policy), Some(proof_address))
    );
    let reputation: AgentReputation = r.w.h.account(&reputation_address(&r.agent.record)).unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, p.net_amount)
    );
}

#[test]
fn a_final_refusal_refunds_the_net_to_the_institution() {
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, _) = ready(&mut r, "a");
    // ADR 0028'den sonra kalıcı ret yalnızca alacak satılınca çıkabilir: alıcı kurumun politikasında engelli.
    // Satılmış alacak iadede `Defaulted` olur.
    let buyer = r.sell_claim_to_blocked_buyer(&job);
    let settlement = r.settlement(&keeper, buyer);
    let p = r.proof("refused_blocked_buyer");
    r.bind(&job, &p).expect("ret ispatı");
    let before = r.w.balance(&settlement.institution_token_account).unwrap();
    let buyer_before = r.w.balance(&settlement.payee_token_account).unwrap();

    let executed = r
        .finalize(&keeper, &job, settlement)
        .expect("finalize_payment");
    let amount = r.amount("a");
    let refund = amount - fee(amount);
    assert_eq!(p.net_amount, refund);
    assert_eq!(
        r.w.balance(&settlement.institution_token_account),
        Some(before + refund)
    );
    assert_eq!(
        r.w.balance(&settlement.keeper_token_account),
        Some(fee(amount))
    );
    assert_eq!(
        r.w.balance(&settlement.payee_token_account),
        Some(buyer_before)
    );
    assert_eq!(r.w.job(&job).status, JobStatus::Refunded);
    assert_eq!(r.w.claim(&job).status, ClaimStatus::Defaulted);

    let refused: ReleaseRefused = event(&executed);
    assert_eq!(
        (
            refused.job,
            refused.refusal_code,
            refused.refunded_amount,
            refused.release_proof
        ),
        (job, 8, refund, release_proof_address(&job))
    );
    assert!(events::<ReleaseVerified>(&executed).is_empty());
    assert_eq!(event::<Finalized>(&executed).keeper_fee, fee(amount));
    // İspat tüketildi ama ödeme yapılmadığı için sayaç ilerlemedi.
    assert!(r.release_proof(&job).consumed);
    assert_eq!(r.operator_state().daily_spent, 0);
    let validation: ValidationRecord = r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (validation.outcome, validation.refusal_code),
        (ValidationOutcome::Refused, 8)
    );
    assert_eq!(
        event::<ValidationRecorded>(&executed).outcome,
        ValidationOutcome::Refused
    );
    // Ret agent'ın tamamladığı iş sayılmaz.
    let reputation: AgentReputation = r.w.h.account(&reputation_address(&r.agent.record)).unwrap();
    assert_eq!((reputation.jobs_completed, reputation.total_earned), (0, 0));
}

#[test]
fn a_temporary_or_declared_refusal_keeps_the_escrow_waiting() {
    // Kategori kurumun beyanıdır; tek başına iade etmez. Kurum uyumlu ispat bağlayınca ödenir.
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    r.bind(&job, &r.proof("refused_category"))
        .expect("kategori reddi");
    r.finalize(&keeper, &job, settlement)
        .expect_err("kategori reddi")
        .assert_error(anchor_error(EscrowError::ProofRequired));
    assert_eq!(r.w.job(&job).status, JobStatus::Delivered);
    r.bind(&job, &r.proof("compliant")).expect("uyumlu ispat");
    r.finalize(&keeper, &job, settlement).expect("ödeme");
    assert_eq!(r.w.job(&job).status, JobStatus::Released);

    // Zaman penceresi dışı: pencere açılınca geçebilir, iade etmez.
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    let p = r.proof("refused_time_window");
    r.w.h.set_time(p.timestamp);
    r.bind(&job, &p).expect("pencere dışı ret");
    r.finalize(&keeper, &job, settlement)
        .expect_err("pencere dışı")
        .assert_error(anchor_error(EscrowError::ProofRequired));
    assert_eq!(r.w.job(&job).status, JobStatus::Delivered);
}

#[test]
fn a_stale_proof_waits_until_the_institution_rebinds() {
    let mut r = ReleaseWorld::new(true);
    // İki iş de ispatların anından önce teslim edilir; pencereleri kapanmıştır.
    let job_b = r.delivered_job("b");
    let (job_a, keeper, settlement) = ready(&mut r, "a");
    r.bind(&job_a, &r.proof("compliant")).expect("A");
    r.bind(&job_b, &r.proof("job_b")).expect("B");
    r.finalize(&keeper, &job_b, settlement)
        .expect("B'nin release'i");
    let b_net = r.proof("job_b").net_amount;
    assert_eq!(r.operator_state().daily_spent, b_net);

    // B sayacı ilerletti: sayaç 0'a göre yapılmış A ispatı bayat, escrow bekler.
    r.finalize(&keeper, &job_a, settlement)
        .expect_err("bayat ispat")
        .assert_error(anchor_error(EscrowError::StaleReleaseProof));
    assert_eq!(r.w.job(&job_a).status, JobStatus::Delivered);
    let current = r.proof("after_job_b");
    r.bind(&job_a, &current).expect("güncel ispat");
    r.finalize(&keeper, &job_a, settlement)
        .expect("A'nın release'i");
    assert_eq!(r.operator_state().daily_spent, b_net + current.net_amount);

    // Gün dönümü: dünün ispatı bayat.
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    r.bind(&job, &r.proof("compliant")).expect("bağlama");
    r.w.h
        .set_time(square_common::time::day_start(r.proof_time()) + DAY);
    r.finalize(&keeper, &job, settlement)
        .expect_err("dünün ispatı")
        .assert_error(anchor_error(EscrowError::StaleReleaseProof));
}

#[test]
fn a_changed_payee_makes_the_proof_stale() {
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, _) = ready(&mut r, "a");
    r.bind(&job, &r.proof("compliant")).expect("bağlama");
    // İspat bağlandıktan sonra alacak satıldı: payee artık alıcı.
    let buyer = r.sell_claim_to_fixture_buyer(&job);
    let settlement = r.settlement(&keeper, buyer);
    r.finalize(&keeper, &job, settlement)
        .expect_err("payee değişti")
        .assert_error(anchor_error(EscrowError::StaleReleaseProof));
    r.bind(&job, &r.proof("buyer_payee"))
        .expect("alıcıya ispat");
    let before = r.w.balance(&settlement.payee_token_account).unwrap();
    r.finalize(&keeper, &job, settlement)
        .expect("alıcıya ödeme");
    assert_eq!(
        r.w.balance(&settlement.payee_token_account),
        Some(before + r.proof("buyer_payee").net_amount)
    );
}

#[test]
fn a_forged_release_proof_or_counter_is_rejected() {
    let mut r = ReleaseWorld::new(true);
    let (job_a, keeper, settlement) = ready(&mut r, "a");
    let job_b = r.delivered_job("b");
    r.w.h.set_time(r.proof_time());
    r.bind(&job_b, &r.proof("job_b")).expect("B");

    // Başka bir job'un ispatı: adres `["release_proof", job]` değil.
    let wrong_job = GateAccounts {
        release_proof: release_proof_address(&job_b),
        ..r.gate(&job_a)
    };
    let ix =
        r.w.finalize_ix(&keeper.pubkey(), &job_a, settlement, Some(wrong_job));
    r.w.h
        .send(&[ix], &[&keeper])
        .expect_err("başka job'un ispatı")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));

    // Doğru adreste ama verifier'a ait olmayan hesap.
    let forged = r.release_proof(&job_b);
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(
        &square_verifier::state::ReleaseProof {
            job: job_a,
            ..forged
        },
        &mut data,
    )
    .unwrap();
    let lamports = r.w.h.svm.minimum_balance_for_rent_exemption(data.len());
    r.w.h.set_account(
        release_proof_address(&job_a),
        Account {
            lamports,
            data,
            owner: square_escrow::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    r.finalize(&keeper, &job_a, settlement)
        .expect_err("verifier'a ait değil")
        .assert_error(anchor_error(EscrowError::InvalidReleaseProof));

    // Gerçek ispat, ama sayaç olarak kurumun `OperatorState`'i değil.
    let mut r = ReleaseWorld::new(true);
    let (job, keeper, settlement) = ready(&mut r, "a");
    r.bind(&job, &r.proof("compliant")).expect("bağlama");
    let wrong_state = GateAccounts {
        operator_state: release_proof_address(&job),
        ..r.gate(&job)
    };
    let ix =
        r.w.finalize_ix(&keeper.pubkey(), &job, settlement, Some(wrong_state));
    r.w.h
        .send(&[ix], &[&keeper])
        .expect_err("sayaç hesabı değil")
        .assert_error(anchor_error(EscrowError::InvalidReleaseProof));
    // Config'teki verifier programı değil.
    let mut ix =
        r.w.finalize_ix(&keeper.pubkey(), &job, settlement, Some(r.gate(&job)));
    ix.accounts[13].pubkey = square_policy::ID;
    r.w.h
        .send(&[ix], &[&keeper])
        .expect_err("başka program")
        .assert_error(anchor_error(EscrowError::LinkedProgramMismatch));
    r.finalize(&keeper, &job, settlement)
        .expect("doğru hesaplarla");
}
