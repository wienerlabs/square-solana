//! square_escrow iş yaşam döngüsü (BC-22, sözleşme arayüzü): fonlama iki tarafın da temiz ve taze
//! screening'ini ister; yalnızca job'a bağlı agent cüzdanı fonlanmış işi kabul eder ve teslim eder; kurum
//! işi iptal edip vault'u boşaltır; kayıt sahibi job'u kaydın güncel cüzdanına taşır.

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::JobStatus;
use square_escrow::{JobAccepted, JobAgentWalletSynced, JobCancelled, JobFunded, WorkSubmitted};
use square_program_tests::token;
use square_program_tests::{anchor_error, cu, event};
use square_registry::{AgentStatus, ScreeningStatus};

const DELIVERY_URI: &str = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

#[test]
fn fund_job_locks_the_amount_from_the_institution() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);

    let ix = w.fund_job_ix(&institution, &job);
    let executed = w.h.send(&[ix], &[&institution.key]).expect("fund_job");
    cu::within("escrow.fund_job", &executed, 50_000);
    assert_eq!(w.balance(&vault_address(&job)), Some(AMOUNT));
    assert_eq!(w.balance(&institution.token_account), Some(9 * AMOUNT));
    let funded = w.job(&job);
    assert_eq!((funded.status, funded.funded_at), (JobStatus::Funded, NOW));
    let event: JobFunded = event(&executed);
    assert_eq!((event.job, event.amount), (job, AMOUNT));
    assert_eq!(w.h.lamports(&institution.key.pubkey()), 0);

    let again = w.fund_job_ix(&institution, &job);
    w.h.send(&[again], &[&institution.key])
        .expect_err("iki kez fonlama")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn fund_job_requires_a_clear_and_fresh_screening_on_both_sides() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");
    let ix = w.default_create_ix(&institution.key.pubkey(), &agent, None);
    w.h.send(&[ix], &[&institution.key]).expect("create_job");
    let job = job_address(&institution.key.pubkey(), &SPEC);
    let fund = |w: &mut World| {
        let ix = w.fund_job_ix(&institution, &job);
        w.h.send(&[ix], &[&institution.key])
    };

    fund(&mut w)
        .expect_err("kurumun kaydı yok")
        .assert_error(anchor_error(EscrowError::ScreeningRequired));
    w.screen(&institution.key.pubkey(), ScreeningStatus::Flagged);
    fund(&mut w)
        .expect_err("kurum işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    w.screen(&institution.key.pubkey(), ScreeningStatus::Clear);
    fund(&mut w)
        .expect_err("agent'ın kaydı yok")
        .assert_error(anchor_error(EscrowError::ScreeningRequired));
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Flagged);
    fund(&mut w)
        .expect_err("agent işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);

    // Kayıtlar SCREENING_TTL sonra bayatlar; deadline daha geç bir iş açılır.
    let late_spec = [0x52; 32];
    let ix = w.create_job_ix(
        &institution.key.pubkey(),
        agent.record,
        None,
        late_spec,
        AMOUNT,
        NOW + 2 * SCREENING_TTL,
        CHALLENGE,
        w.usdc,
    );
    w.h.send(&[ix], &[&institution.key]).expect("create_job");
    w.h.set_time(NOW + SCREENING_TTL);
    let late = job_address(&institution.key.pubkey(), &late_spec);
    let ix = w.fund_job_ix(&institution, &late);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("bayat kayıt")
        .assert_error(anchor_error(EscrowError::ScreeningExpired));
    w.screen(&institution.key.pubkey(), ScreeningStatus::Clear);
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
    let ix = w.fund_job_ix(&institution, &late);
    w.h.send(&[ix], &[&institution.key])
        .expect("yenilenen kayıtlarla");
    assert_eq!(w.balance(&vault_address(&late)), Some(AMOUNT));
}

#[test]
fn fund_job_checks_accounts_deadline_and_travel_rule_threshold() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let stranger = w.institution(AMOUNT);

    // Başkasının token hesabından fonlanamaz.
    let ix = w.fund_job_ix_with(
        &institution.key.pubkey(),
        &job,
        stranger.token_account,
        vault_address(&job),
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("başkasının token hesabı")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    // İşi yalnızca kendi kurumu fonlar.
    let ix = w.fund_job_ix_with(
        &stranger.key.pubkey(),
        &job,
        stranger.token_account,
        vault_address(&job),
    );
    w.h.send(&[ix], &[&stranger.key])
        .expect_err("başka kurum")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    // Başka mint'teki token hesabı.
    let other_mint = token::create_usdc_mint(&mut w.h, &w.mint_authority.pubkey());
    let other_account = token::create_ata(&mut w.h, &institution.key.pubkey(), &other_mint);
    let ix = w.fund_job_ix_with(
        &institution.key.pubkey(),
        &job,
        other_account,
        vault_address(&job),
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("başka mint")
        .assert_error(anchor_error(EscrowError::MintMismatch));

    // Travel Rule eşiği (BC-34): commitment bağlanmamış, eşiği aşan iş fonlanmaz.
    let admin = w.admin.insecure_clone();
    let threshold = square_escrow::EscrowParams {
        travel_rule_threshold: AMOUNT,
        ..params()
    };
    let ix = w.update_params_ix(&admin.pubkey(), threshold);
    w.h.send(&[ix], &[&admin]).expect("update_params");
    let ix = w.fund_job_ix(&institution, &job);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("Travel Rule commitment'ı yok")
        .assert_error(anchor_error(EscrowError::TravelRuleCommitmentRequired));
    let below = square_escrow::EscrowParams {
        travel_rule_threshold: AMOUNT + 1,
        ..params()
    };
    let ix = w.update_params_ix(&admin.pubkey(), below);
    w.h.send(&[ix], &[&admin]).expect("update_params");

    w.h.set_time(w.job(&job).deadline);
    let ix = w.fund_job_ix(&institution, &job);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("deadline geçti")
        .assert_error(anchor_error(EscrowError::DeadlineExpired));
}

#[test]
fn an_unfunded_job_cannot_be_accepted() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.open_job(false);
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("fonlanmamış")
        .assert_error(anchor_error(EscrowError::JobNotFunded));
    assert_eq!(w.job(&job).status, JobStatus::Open);
}

#[test]
fn only_the_bound_agent_wallet_accepts_with_the_committed_spec() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.funded_job();
    let other = w.register_agent("other-agent");

    let cases = [
        (
            "başka imzacı",
            &other.wallet,
            agent.record,
            SPEC,
            EscrowError::AgentMismatch,
        ),
        (
            "başka agent'ın kaydı",
            &agent.wallet,
            other.record,
            SPEC,
            EscrowError::AgentMismatch,
        ),
        (
            "farklı spec",
            &agent.wallet,
            agent.record,
            [0x99; 32],
            EscrowError::SpecHashMismatch,
        ),
    ];
    for (label, signer, record, spec, error) in cases {
        let ix = w.accept_ix(&signer.pubkey(), &job, record, spec);
        w.h.send(&[ix], &[signer])
            .expect_err(label)
            .assert_error(anchor_error(error));
    }

    w.set_agent_status(&agent, AgentStatus::Inactive)
        .expect("Inactive");
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("Inactive agent kabul edemez")
        .assert_error(anchor_error(EscrowError::AgentInactive));
    w.set_agent_status(&agent, AgentStatus::Active)
        .expect("Active");

    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    let executed = w.h.send(&[ix], &[&agent.wallet]).expect("accept_job");
    cu::within("escrow.accept_job", &executed, 20_000);
    assert_eq!(w.job(&job).status, JobStatus::Accepted);
    let accepted: JobAccepted = event(&executed);
    assert_eq!(
        (accepted.job, accepted.agent_record, accepted.agent_wallet),
        (job, agent.record, agent.wallet.pubkey())
    );
    // Agent cüzdanı lamport tutmaz; ücret payer'dan.
    assert_eq!(w.h.lamports(&agent.wallet.pubkey()), 0);
}

#[test]
fn accept_job_stops_at_the_deadline() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.funded_job();
    w.h.set_time(w.job(&job).deadline);
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("deadline")
        .assert_error(anchor_error(EscrowError::DeadlineExpired));
}

#[test]
fn only_the_bound_registered_agent_submits_and_the_challenge_window_opens() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.funded_job();
    let other = w.register_agent("other-agent");

    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, DELIVERY_URI);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("kabul edilmemiş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&agent.wallet]).expect("accept_job");

    for (label, signer, record) in [
        ("başka imzacı", &other.wallet, agent.record),
        ("başka agent'ın kaydı", &agent.wallet, other.record),
    ] {
        let ix = w.submit_ix(&signer.pubkey(), &job, record, DELIVERY_URI);
        w.h.send(&[ix], &[signer])
            .expect_err(label)
            .assert_error(anchor_error(EscrowError::AgentMismatch));
    }
    let too_long = "x".repeat(129);
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, &too_long);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("129 baytlık URI")
        .assert_error(anchor_error(EscrowError::DeliveryUriTooLong));

    // Kabul edilmiş iş, sonradan Inactive olan kayıtla da teslim edilir (program arayüzü §6).
    w.set_agent_status(&agent, AgentStatus::Inactive)
        .expect("Inactive");
    w.h.advance(HOUR);
    let uri = "x".repeat(128);
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, &uri);
    let executed = w.h.send(&[ix], &[&agent.wallet]).expect("submit_work");
    cu::within("escrow.submit_work", &executed, 20_000);
    let delivered = w.job(&job);
    let now = NOW + HOUR;
    assert_eq!(delivered.status, JobStatus::Delivered);
    assert_eq!(delivered.work_hash, WORK);
    assert_eq!(delivered.delivery_uri, uri);
    assert_eq!(delivered.delivered_at, now);
    assert_eq!(delivered.challenge_end, now + CHALLENGE as i64);
    let submitted: WorkSubmitted = event(&executed);
    assert_eq!(
        (submitted.job, submitted.work_hash, submitted.challenge_end),
        (job, WORK, now + CHALLENGE as i64)
    );
    assert_eq!(submitted.delivery_uri, uri);

    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, DELIVERY_URI);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("ikinci teslim")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn a_deregistered_agent_cannot_submit_and_nobody_submits_after_the_deadline() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.accepted_job();
    w.deregister_agent(&agent).expect("deregister_agent");
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, DELIVERY_URI);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("kalıcı olarak silinmiş kayıt")
        .assert_error(anchor_error(EscrowError::AgentNotRegistered));

    let mut w = World::new(true);
    let (_institution, agent, job) = w.accepted_job();
    w.h.set_time(w.job(&job).deadline);
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, DELIVERY_URI);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("deadline")
        .assert_error(anchor_error(EscrowError::DeadlineExpired));
}

#[test]
fn cancel_refunds_the_vault_and_returns_its_rent_to_the_payer() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.funded_job();
    let vault = vault_address(&job);
    let rent_payer = w.h.payer.pubkey();
    let vault_rent = w.h.lamports(&vault);
    assert!(vault_rent > 0);

    let stranger = w.institution(0);
    let ix = w.cancel_ix(
        &stranger.key.pubkey(),
        &job,
        stranger.token_account,
        vault,
        rent_payer,
    );
    w.h.send(&[ix], &[&stranger.key])
        .expect_err("başka kurum")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault,
        Pubkey::new_unique(),
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("rent başka hesaba")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    // Sahte vault: job'a ait ama kanonik PDA olmayan boş bir token hesabı (Covenant guard'ı).
    let decoy = token::create_ata(&mut w.h, &job, &w.usdc);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        decoy,
        rent_payer,
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("sahte vault")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));

    // Rent'i sponsor öder: işlem ücreti de payer'dan, ikisi ayrı ölçülür.
    let payer_before = w.h.lamports(&rent_payer);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault,
        rent_payer,
    );
    let executed = w.h.send(&[ix], &[&institution.key]).expect("cancel_job");
    cu::within("escrow.cancel_job", &executed, 30_000);
    assert_eq!(w.balance(&institution.token_account), Some(10 * AMOUNT));
    assert_eq!(w.balance(&vault), None, "vault kapandı");
    let fee = 2 * 5_000; // payer ve kurum imzası
    assert_eq!(w.h.lamports(&rent_payer), payer_before + vault_rent - fee);
    let cancelled = w.job(&job);
    assert_eq!(
        (cancelled.status, cancelled.settled_at),
        (JobStatus::Cancelled, NOW)
    );
    let event: JobCancelled = event(&executed);
    assert_eq!((event.job, event.refunded_amount), (job, AMOUNT));

    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault,
        rent_payer,
    );
    assert!(
        w.h.send(&[ix], &[&institution.key]).is_err(),
        "ikinci iptal"
    );
}

#[test]
fn an_open_job_cancels_without_a_refund() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault_address(&job),
        w.h.payer.pubkey(),
    );
    let executed = w.h.send(&[ix], &[&institution.key]).expect("cancel_job");
    assert_eq!(event::<JobCancelled>(&executed).refunded_amount, 0);
    assert_eq!(w.job(&job).status, JobStatus::Cancelled);
    assert_eq!(w.balance(&institution.token_account), Some(10 * AMOUNT));
}

#[test]
fn an_accepted_job_cancels_only_after_the_deadline_and_a_delivered_one_never() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.accepted_job();
    let cancel = |w: &World| {
        w.cancel_ix(
            &institution.key.pubkey(),
            &job,
            institution.token_account,
            vault_address(&job),
            w.h.payer.pubkey(),
        )
    };
    let ix = cancel(&w);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("deadline geçmedi")
        .assert_error(anchor_error(EscrowError::DeadlineNotExpired));
    w.h.set_time(w.job(&job).deadline);
    let ix = cancel(&w);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("deadline anı")
        .assert_error(anchor_error(EscrowError::DeadlineNotExpired));
    w.h.advance(1);
    let ix = cancel(&w);
    w.h.send(&[ix], &[&institution.key])
        .expect("deadline sonrası");
    assert_eq!(w.balance(&institution.token_account), Some(10 * AMOUNT));

    let mut w = World::new(true);
    let (institution, agent, job) = w.accepted_job();
    let ix = w.submit_ix(&agent.wallet.pubkey(), &job, agent.record, DELIVERY_URI);
    w.h.send(&[ix], &[&agent.wallet]).expect("submit_work");
    w.h.set_time(w.job(&job).deadline + 1);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault_address(&job),
        w.h.payer.pubkey(),
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("teslim edilmiş iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn the_record_owner_moves_an_unsettled_job_to_the_rotated_wallet() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.funded_job();
    let rotated = Keypair::new();
    w.rotate_wallet(&agent, rotated.pubkey())
        .expect("update_agent");
    assert_eq!(
        w.job(&job).agent_wallet,
        agent.wallet.pubkey(),
        "job eski cüzdanda kalır"
    );

    // Yeni cüzdan, job taşınmadan kabul edemez.
    let ix = w.accept_ix(&rotated.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&rotated])
        .expect_err("taşınmamış job")
        .assert_error(anchor_error(EscrowError::AgentMismatch));

    for (label, signer) in [("eski cüzdan", &agent.wallet), ("yeni cüzdan", &rotated)] {
        let ix = w.sync_ix(&signer.pubkey(), &job, agent.record);
        w.h.send(&[ix], &[signer])
            .expect_err(label)
            .assert_error(anchor_error(EscrowError::Unauthorized));
    }
    let ix = w.sync_ix(&agent.owner.pubkey(), &job, agent.record);
    let executed = w.h.send(&[ix], &[&agent.owner]).expect("sync_agent_wallet");
    assert_eq!(w.job(&job).agent_wallet, rotated.pubkey());
    let synced: JobAgentWalletSynced = event(&executed);
    assert_eq!((synced.job, synced.agent_wallet), (job, rotated.pubkey()));

    let ix = w.accept_ix(&rotated.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&rotated])
        .expect("yeni cüzdanla accept_job");

    // Kapanmış (iptal edilmiş) iş taşınamaz.
    w.h.set_time(w.job(&job).deadline + 1);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        vault_address(&job),
        w.h.payer.pubkey(),
    );
    w.h.send(&[ix], &[&institution.key]).expect("cancel_job");
    let ix = w.sync_ix(&agent.owner.pubkey(), &job, agent.record);
    w.h.send(&[ix], &[&agent.owner])
        .expect_err("kapanmış iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}
