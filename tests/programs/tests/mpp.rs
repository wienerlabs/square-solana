//! Stripe MPP fiat rayı (BC-37, ADR 0024): fiat iş vault'suz açılır, agent açıkken kabul eder ve teslim
//! eder; kurum Stripe ile öder, MPP authority'nin attestation'ı (aynı tx'te Ed25519 precompile) ve release
//! devresinin gerçek ispatı (`stripe_receipt_hash` ≠ 0) verifier'da işe bağlanır; `finalize_fiat_payment`
//! işi `Released` yapar, günlük sayaç, itibar ve validation kaydı USDC yolundaki gibi yazılır.
//!
//! İspat `tests/fixtures/release-proofs.json`'ın `mpp_fiat` senaryosudur (fiat iş `d`, tutarın tamamı,
//! makbuz commitment'ı sinyal 12). MPP authority'si testin anahtarıdır; config'e `init_verifier_config`
//! ile yazılır, `update_mpp_authority` ile program upgrade'i olmadan değişir.

mod escrow_world;
mod fiat_world;
mod release_world;

use escrow_world::*;
use fiat_world::*;
use release_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::mpp::attestation_message;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, JobStatus, SettlementRail, ValidationOutcome, ValidationRecord,
};
use square_escrow::{FiatJobCreated, Finalized, JobCancelled, ReleaseVerified};
use square_program_tests::{anchor_error, compute_unit_limit, cu, event};
use square_registry::ScreeningStatus;
use square_verifier::errors::VerifierError;
use square_verifier::state::{ReleaseVerdict, VerifierConfig};
use square_verifier::{ComplianceProofSet, MppPaymentVerified, VerifierConfigUpdated};

#[test]
fn a_stripe_payment_settles_a_fiat_job() {
    let mut f = FiatWorld::new();
    let executed = f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    let created: FiatJobCreated = event(&executed);
    assert_eq!(
        (created.job, created.policy, created.amount),
        (job, f.r.policy.policy, f.r.amount(FIAT))
    );
    let state = f.r.w.job(&job);
    assert_eq!(
        (
            state.rail,
            state.status,
            state.challenge_period,
            state.vault_bump
        ),
        (SettlementRail::Fiat, JobStatus::Open, 0, 0)
    );
    // Vault yok: fonlama zincirde değil.
    assert!(f.r.w.h.raw_account(&vault_address(&job)).is_none());

    // Agent açık işi kabul eder ve teslim eder; ödeme Stripe'ta.
    let job = {
        let wallet = f.r.agent.wallet.insecure_clone();
        let (record, spec) = (f.r.agent.record, f.r.spec(FIAT));
        let ix = f.r.w.accept_ix(&wallet.pubkey(), &job, record, spec);
        f.r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
        let ix =
            f.r.w
                .submit_ix(&wallet.pubkey(), &job, record, DELIVERY_URI);
        f.r.w.h.send(&[ix], &[&wallet]).expect("submit_work");
        job
    };
    f.r.w.h.set_time(f.r.proof_time());
    let executed = f.verify(&job).expect("verify_mpp_payment_proof");
    cu::within_profile(
        "verifier.verify_mpp_payment_proof",
        &executed,
        "verifyMppPaymentProof",
    );
    let amount = f.r.amount(FIAT);
    let proof = f.r.release_proof(&job);
    assert_eq!(
        (proof.verdict, proof.refusal_code, proof.consumed),
        (ReleaseVerdict::Compliant, 0, false)
    );
    assert_eq!(
        (proof.payee, proof.net_amount, proof.mint),
        (f.r.agent.wallet.pubkey(), amount, f.r.w.usdc)
    );
    let set: ComplianceProofSet = event(&executed);
    assert_eq!((set.job, set.net_amount), (job, amount));
    let paid: MppPaymentVerified = event(&executed);
    assert_eq!(
        (paid.job, paid.institution, paid.policy),
        (job, f.r.policy.institution, f.r.policy.policy)
    );
    assert_eq!(
        (paid.stripe_receipt_hash, paid.amount),
        (f.receipt(), amount)
    );

    // Challenge penceresi yok: kurumun ödemesi teslimin kabulüdür.
    let executed = f.finalize(&job).expect("finalize_fiat_payment");
    cu::within_profile(
        "escrow.finalize_fiat_payment",
        &executed,
        "finalizeFiatPayment",
    );
    let state = f.r.w.job(&job);
    assert_eq!(state.status, JobStatus::Released);
    assert!(f.r.release_proof(&job).consumed);
    assert_eq!(f.r.operator_state().daily_spent, amount);
    let record: ValidationRecord = f.r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (record.outcome, record.release_proof),
        (
            ValidationOutcome::Verified,
            Some(release_proof_address(&job))
        )
    );
    let reputation: AgentReputation =
        f.r.w
            .h
            .account(&reputation_address(&f.r.agent.record))
            .unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, amount)
    );
    let finalized: Finalized = event(&executed);
    assert_eq!(finalized.keeper_fee, 0);
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (verified.payee, verified.net_amount),
        (f.r.agent.wallet.pubkey(), amount)
    );

    // İş kapandı: validation kaydı bir kez açılır, ikinci finalize reddedilir.
    assert!(f.finalize(&job).is_err());
    assert_eq!(f.r.w.job(&job).status, JobStatus::Released);
}

#[test]
fn only_an_attestation_of_the_config_authority_for_this_job_and_amount_binds() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    f.r.w.h.set_time(f.r.proof_time());
    let amount = f.r.amount(FIAT);
    let invalid = anchor_error(VerifierError::InvalidMppAttestation);

    f.verify_with(&job, None)
        .expect_err("attestation yok")
        .assert_error(invalid);
    let stranger = Keypair::new();
    let wrong_signer = f.attestation(&stranger, &job, amount);
    f.verify_with(&job, Some(wrong_signer))
        .expect_err("başka anahtar")
        .assert_error(invalid);
    let wrong_amount = f.attestation(&f.mpp, &job, amount - 1);
    f.verify_with(&job, Some(wrong_amount))
        .expect_err("başka tutar")
        .assert_error(invalid);
    let other_job = f.attestation(&f.mpp, &f.r.job_address("a"), amount);
    f.verify_with(&job, Some(other_job))
        .expect_err("başka iş")
        .assert_error(invalid);
    // Attestation başka bir makbuzu imzalıyor.
    let other_receipt = ed25519_ix(&f.mpp, &attestation_message(&job, &[9; 32], amount));
    f.verify_with(&job, Some(other_receipt))
        .expect_err("başka makbuz")
        .assert_error(invalid);
    // İmzası geçersiz precompile talimatı tx'i düşürür.
    let mut forged = f.attestation(&f.mpp, &job, amount);
    forged.data[48] ^= 1;
    assert!(f.verify_with(&job, Some(forged)).is_err());

    // Escrow release yolunun sıfır commitment'ı MPP ispatı değildir.
    let p = f.r.proof(SCENARIO);
    let zero = ed25519_ix(&f.mpp, &attestation_message(&job, &[0; 32], amount));
    let verify = f.verify_ix(&job, &p, [0; 32]);
    let institution = f.institution();
    f.r.w
        .h
        .send(
            &[compute_unit_limit(CU_LIMIT), zero, verify],
            &[&institution],
        )
        .expect_err("sıfır makbuz")
        .assert_error(invalid);

    // Doğru attestation, başka bir senaryonun ispatıyla: devre doğrulamaz.
    let wrong_proof = f.r.proof("compliant");
    let attestation = f.attestation(&f.mpp, &job, amount);
    let verify = f.verify_ix(&job, &wrong_proof, f.receipt());
    f.r.w
        .h
        .send(
            &[compute_unit_limit(CU_LIMIT), attestation, verify],
            &[&institution],
        )
        .expect_err("başka ispat")
        .assert_error(anchor_error(VerifierError::InvalidProof));

    // İspatın anı tolerans dışında.
    f.r.w.h.set_time(f.r.proof_time() + 2 * HOUR);
    f.verify(&job)
        .expect_err("bayat")
        .assert_error(anchor_error(VerifierError::StaleProof));
    f.r.w.h.set_time(f.r.proof_time());
    f.verify(&job).expect("doğru attestation ve ispat");
}

#[test]
fn the_admin_rotates_the_authority_without_an_upgrade() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    f.r.w.h.set_time(f.r.proof_time());
    let next = Keypair::new();

    let stranger = f.r.w.h.funded(1_000_000_000);
    let ix = f.update_authority_ix(&stranger.pubkey(), next.pubkey());
    f.r.w
        .h
        .send(&[ix], &[&stranger])
        .expect_err("admin değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    let admin = f.r.w.admin.insecure_clone();
    let ix = f.update_authority_ix(&admin.pubkey(), next.pubkey());
    let executed =
        f.r.w
            .h
            .send(&[ix], &[&admin])
            .expect("update_mpp_authority");
    let updated: VerifierConfigUpdated = event(&executed);
    assert_eq!(updated.mpp_authority, next.pubkey());
    let config: VerifierConfig = f.r.w.h.account(&verifier_config_address()).unwrap();
    assert_eq!(config.mpp_authority, next.pubkey());

    // Eski anahtarın attestation'ı artık bağlanmaz, yenisininki bağlanır.
    f.verify(&job)
        .expect_err("eski anahtar")
        .assert_error(anchor_error(VerifierError::InvalidMppAttestation));
    let amount = f.r.amount(FIAT);
    let attestation = f.attestation(&next, &job, amount);
    f.verify_with(&job, Some(attestation))
        .expect("yeni anahtar");
}

#[test]
fn escrow_paths_do_not_apply_to_fiat_jobs_and_fiat_paths_not_to_escrow_jobs() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    let rail = anchor_error(EscrowError::RailMismatch);

    // Dispute ve alacak fiat işte yok.
    let wallet = f.r.agent.wallet.insecure_clone();
    f.r.w
        .list_claim(&wallet, &job, 1_000_000)
        .expect_err("alacak")
        .assert_error(rail);
    let institution = Institution {
        key: f.institution(),
        token_account: f.r.institution.token_account,
    };
    f.r.w
        .raise_dispute(&institution, &job, 1_000_000)
        .expect_err("dispute")
        .assert_error(rail);

    // Fiat işe USDC ispatı bağlanamaz.
    f.r.w.h.set_time(f.r.proof_time());
    let p = f.r.proof(SCENARIO);
    f.r.bind(&job, &p)
        .expect_err("set_compliance_proof")
        .assert_error(anchor_error(VerifierError::RailMismatch));

    // Escrow işine MPP ispatı bağlanamaz, fiat finalize ve iptal escrow işine uygulanmaz.
    let escrow_job = f.r.delivered_job("a");
    let attestation = f.attestation(&f.mpp, &escrow_job, f.r.amount("a"));
    f.verify_with(&escrow_job, Some(attestation))
        .expect_err("escrow işi")
        .assert_error(anchor_error(VerifierError::RailMismatch));
    f.finalize(&escrow_job)
        .expect_err("escrow işi")
        .assert_error(rail);
    f.cancel(&escrow_job)
        .expect_err("escrow işi")
        .assert_error(rail);

    // İspat bağlanmadan fiat iş kapanmaz.
    f.finalize(&job)
        .expect_err("ispat yok")
        .assert_error(anchor_error(EscrowError::ProofRequired));
}

#[test]
fn a_fiat_job_needs_clear_screenings_and_can_be_cancelled() {
    let mut f = FiatWorld::new();
    let wallet = f.r.agent.wallet.pubkey();
    f.r.w.screen(&wallet, ScreeningStatus::Flagged);
    f.create()
        .expect_err("agent işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    f.r.w.screen(&wallet, ScreeningStatus::Clear);

    f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    // Fonlama adımı yok; Travel Rule commitment'ı fonlamaya bağlıdır.
    let institution = f.institution();
    let ix =
        f.r.w
            .commit_travel_rule_ix(&institution.pubkey(), &job, [0x2c; 32]);
    f.r.w
        .h
        .send(&[ix], &[&institution])
        .expect_err("travel rule")
        .assert_error(anchor_error(EscrowError::RailMismatch));

    let executed = f.cancel(&job).expect("cancel_fiat_job");
    let cancelled: JobCancelled = event(&executed);
    assert_eq!((cancelled.job, cancelled.refunded_amount), (job, 0));
    assert_eq!(f.r.w.job(&job).status, JobStatus::Cancelled);
    f.cancel(&job)
        .expect_err("iptal edilmiş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn an_accepted_fiat_job_is_cancelled_only_after_the_deadline() {
    let mut f = FiatWorld::new();
    f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    let wallet = f.r.agent.wallet.insecure_clone();
    let ix =
        f.r.w
            .accept_ix(&wallet.pubkey(), &job, f.r.agent.record, f.r.spec(FIAT));
    f.r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
    f.cancel(&job)
        .expect_err("son tarihten önce")
        .assert_error(anchor_error(EscrowError::DeadlineNotExpired));
    f.r.w.h.advance(8 * DAY);
    f.cancel(&job).expect("son tarihten sonra");
}

/// `rail` alanından önce açılmış job hesapları (bir bayt kısa) `Escrow` okunur ve yazılabilir.
#[test]
fn jobs_created_before_the_rail_field_read_as_escrow() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let mut account = w.h.raw_account(&job).unwrap();
    assert_eq!(account.data.last(), Some(&0));
    account.data.truncate(account.data.len() - 1);
    w.h.set_account(job, account);

    let ix = w.fund_job_ix(&institution, &job);
    let key = institution.key.insecure_clone();
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let state = w.job(&job);
    assert_eq!(
        (state.rail, state.status),
        (SettlementRail::Escrow, JobStatus::Funded)
    );
}
