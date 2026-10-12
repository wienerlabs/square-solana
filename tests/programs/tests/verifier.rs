//! square_verifier (BC-21, sözleşme arayüzü): release ispatının job'a bağlanması ve günlük sayaç.
//!
//! İspatlar gerçek Groth16 ispatlarıdır (tests/fixtures/release-proofs.json,
//! circuits/payment-compliance/scripts/program-proofs.mjs). Kurum ve agent cüzdanı, settlement mint'i
//! ve politika devrenin test dünyasıyla aynı etiketlerden türetilir; job'lar escrow'un kendi
//! instruction'larıyla teslim edilir (`release_world`). Böylece programın hesaplardan kurduğu sinyaller
//! ispatın sinyalleriyle yalnızca her şey doğruysa eşleşir.

mod escrow_world;
mod release_world;

use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use release_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::release::{ReleaseFacts, Staleness};
use square_common::time::day_start;
use square_program_tests::{anchor_error, compute_unit_limit, cu, event};
use square_verifier::errors::VerifierError;
use square_verifier::state::VerifierConfig;
use square_verifier::{
    ComplianceProofSet, ReleaseRecorded, ReleaseVerdict, VerifierConfigUpdated,
    CLOCK_TOLERANCE_SECS, RELEASE_VK_VERSION,
};

#[test]
fn only_the_upgrade_authority_initializes_the_config() {
    let mut r = ReleaseWorld::deployed(true);
    let mpp = Pubkey::new_unique();
    let stranger = r.w.h.funded(1_000_000_000);
    r.w.h
        .send(&[init_config_ix(&stranger.pubkey(), mpp)], &[&stranger])
        .expect_err("yükseltme yetkilisi değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    let admin = r.w.admin.insecure_clone();
    let executed =
        r.w.h
            .send(&[init_config_ix(&admin.pubkey(), mpp)], &[&admin])
            .expect("init_verifier_config");
    let config: VerifierConfig = r.w.h.account(&verifier_config_address()).unwrap();
    assert_eq!(
        (
            config.admin,
            config.escrow_program,
            config.policy_program,
            config.mpp_authority
        ),
        (admin.pubkey(), square_escrow::ID, square_policy::ID, mpp)
    );
    assert_eq!(config.vk_version, RELEASE_VK_VERSION);
    let updated: VerifierConfigUpdated = event(&executed);
    assert_eq!(
        (
            updated.admin,
            updated.escrow_program,
            updated.mpp_authority,
            updated.vk_version
        ),
        (admin.pubkey(), square_escrow::ID, mpp, RELEASE_VK_VERSION)
    );
    assert!(r
        .w
        .h
        .send(&[init_config_ix(&admin.pubkey(), mpp)], &[&admin])
        .is_err());
}

#[test]
fn after_an_upgrade_the_admin_records_the_embedded_key_version() {
    let mut r = ReleaseWorld::deployed(true);
    let admin = r.w.admin.insecure_clone();
    let mpp = Pubkey::new_unique();
    r.w.h
        .send(&[init_config_ix(&admin.pubkey(), mpp)], &[&admin])
        .expect("init_verifier_config");

    // Config programla aynı sürümde: eşitlenecek bir şey yok, çağrı düşer.
    r.w.h
        .send(&[sync_vk_version_ix(&admin.pubkey())], &[&admin])
        .expect_err("aynı sürüm")
        .assert_error(anchor_error(VerifierError::VkVersionAlreadySynced));

    // Upgrade'den önceki programın yazdığı config: anahtarın bir önceki sürümü (BC-38'de geliştirme
    // anahtarıyla kurulmuş config, tören anahtarını taşıyan programa yükseltilir).
    let address = verifier_config_address();
    let config: VerifierConfig = r.w.h.account(&address).unwrap();
    let mut account = r.w.h.raw_account(&address).unwrap();
    account.data.clear();
    anchor_lang::AccountSerialize::try_serialize(
        &VerifierConfig {
            vk_version: RELEASE_VK_VERSION - 1,
            ..config
        },
        &mut account.data,
    )
    .unwrap();
    r.w.h.set_account(address, account);

    let stranger = r.w.h.funded(1_000_000_000);
    r.w.h
        .send(&[sync_vk_version_ix(&stranger.pubkey())], &[&stranger])
        .expect_err("config'in admin'i değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    let executed =
        r.w.h
            .send(&[sync_vk_version_ix(&admin.pubkey())], &[&admin])
            .expect("sync_vk_version");
    let synced: VerifierConfig = r.w.h.account(&address).unwrap();
    assert_eq!(synced.vk_version, RELEASE_VK_VERSION);
    // Yalnızca sürüm değişir.
    assert_eq!(
        (
            synced.admin,
            synced.escrow_program,
            synced.policy_program,
            synced.mpp_authority,
            synced.bump
        ),
        (
            config.admin,
            config.escrow_program,
            config.policy_program,
            config.mpp_authority,
            config.bump
        )
    );
    let updated: VerifierConfigUpdated = event(&executed);
    assert_eq!(
        (
            updated.admin,
            updated.escrow_program,
            updated.policy_program,
            updated.mpp_authority,
            updated.vk_version
        ),
        (
            admin.pubkey(),
            square_escrow::ID,
            square_policy::ID,
            mpp,
            RELEASE_VK_VERSION
        )
    );

    // Eşitlendikten sonra ikinci çağrı yine düşer.
    r.w.h
        .send(&[sync_vk_version_ix(&admin.pubkey())], &[&admin])
        .expect_err("eşitlendi")
        .assert_error(anchor_error(VerifierError::VkVersionAlreadySynced));
}

#[test]
fn a_valid_proof_writes_a_compliant_release_proof() {
    let mut r = ReleaseWorld::new(true);
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());
    let p = r.proof("compliant");
    let executed = r.bind(&job, &p).expect("set_compliance_proof");
    cu::within_profile(
        "verifier.set_compliance_proof",
        &executed,
        "setComplianceProof",
    );

    let proof = r.release_proof(&job);
    assert_eq!(
        (proof.job, proof.institution, proof.policy),
        (job, r.policy.institution, r.policy.policy)
    );
    assert_eq!(proof.payee, r.agent.wallet.pubkey());
    assert_eq!((proof.net_amount, proof.mint), (p.net_amount, r.w.usdc));
    assert_eq!(
        (proof.daily_spent_before, proof.proof_timestamp),
        (0, p.timestamp)
    );
    assert_eq!(
        (proof.verdict, proof.refusal_code),
        (ReleaseVerdict::Compliant, 0)
    );
    assert!(!proof.consumed);
    let state = r.operator_state();
    assert_eq!(state.institution, r.policy.institution);
    assert_eq!(
        (state.daily_spent, state.day_start_unix),
        (0, day_start(p.timestamp))
    );
    let set: ComplianceProofSet = event(&executed);
    assert_eq!(
        (set.job, set.policy, set.verdict),
        (job, r.policy.policy, ReleaseVerdict::Compliant)
    );
    assert_eq!(
        (set.payee, set.net_amount, set.mint, set.daily_spent_before),
        (r.agent.wallet.pubkey(), p.net_amount, r.w.usdc, 0)
    );
    // Kurumun lamport'u yok: rent'i payer öder.
    assert_eq!(r.w.h.lamports(&r.institution.key.pubkey()), 0);
}

#[test]
fn a_refusing_proof_records_the_reason_and_can_be_rebound() {
    let mut r = ReleaseWorld::new(true);
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());
    let refused = r.proof("refused_category");
    let executed = r.bind(&job, &refused).expect("ret ispatı");
    let proof = r.release_proof(&job);
    assert_eq!(
        (proof.verdict, proof.refusal_code),
        (ReleaseVerdict::Refused, 16)
    );
    assert_eq!(proof.net_amount, refused.net_amount);
    assert_eq!(event::<ComplianceProofSet>(&executed).refusal_code, 16);

    // Tüketilene kadar yeniden bağlanabilir.
    r.bind(&job, &r.proof("compliant"))
        .expect("yeniden bağlama");
    assert_eq!(r.release_proof(&job).verdict, ReleaseVerdict::Compliant);
}

#[test]
fn a_proof_for_another_payee_amount_mint_policy_or_job_is_rejected() {
    let mut r = ReleaseWorld::new(true);
    let job_a = r.delivered_job("a");
    let job_b = r.delivered_job("b");
    r.w.h.set_time(r.proof_time());
    let compliant = r.proof("compliant");

    let invalid = [
        ("başka payee (alıcı) için", job_a, r.proof("buyer_payee")),
        ("başka mint için", job_a, r.proof("other_mint")),
        ("başka politika için", job_a, r.proof("other_policy")),
        ("başka job için", job_b, compliant.clone()),
        (
            "beyan edilen net farklı",
            job_a,
            Proof {
                net_amount: compliant.net_amount + 1,
                ..compliant.clone()
            },
        ),
        (
            "beyan edilen ret kodu farklı",
            job_a,
            Proof {
                refusal_code: 1,
                ..compliant.clone()
            },
        ),
        (
            "beyan edilen an farklı",
            job_a,
            Proof {
                timestamp: compliant.timestamp + 1,
                ..compliant.clone()
            },
        ),
        (
            "bozulmuş ispat",
            job_a,
            Proof {
                proof_c: {
                    let mut c = compliant.proof_c;
                    c[63] ^= 1;
                    c
                },
                ..compliant.clone()
            },
        ),
    ];
    for (label, job, p) in invalid {
        r.bind(&job, &p)
            .expect_err(label)
            .assert_error(anchor_error(VerifierError::InvalidProof));
    }
    assert!(
        r.w.h.raw_account(&release_proof_address(&job_a)).is_none(),
        "hiçbir ispat yazılmadı"
    );

    // Agent cüzdanı değişince (sync_agent_wallet) eski payee'ye yapılmış ispat geçmez.
    let rotated = Keypair::new();
    r.w.rotate_wallet(&r.agent, rotated.pubkey())
        .expect("update_agent");
    let owner = r.agent.owner.insecure_clone();
    let ix = r.w.sync_ix(&owner.pubkey(), &job_a, r.agent.record);
    r.w.h.send(&[ix], &[&owner]).expect("sync_agent_wallet");
    r.bind(&job_a, &compliant)
        .expect_err("payee değişti")
        .assert_error(anchor_error(VerifierError::InvalidProof));
}

#[test]
fn only_the_institution_authority_binds_to_its_own_policy_job() {
    let mut r = ReleaseWorld::new(true);
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());
    let p = r.proof("compliant");

    let stranger = Keypair::new();
    let ix = r.bind_ix(&stranger.pubkey(), &job, r.policy.policy, &p);
    r.w.h
        .send(&[compute_unit_limit(CU_LIMIT), ix], &[&stranger])
        .expect_err("kurumun yetkilisi değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    // Başka bir kurumun politikası: job'un politikası değil.
    let other_owner = r.w.h.funded(1_000_000_000);
    let other = r.w.policy(&other_owner, [7; 32]);
    let ix = r.bind_ix(&r.institution.key.pubkey(), &job, other.policy, &p);
    let key = r.institution.key.insecure_clone();
    r.w.h
        .send(&[compute_unit_limit(CU_LIMIT), ix], &[&key])
        .expect_err("başka kurumun politikası")
        .assert_error(anchor_error(VerifierError::PolicyMismatch));
    // Policy programına ait olmayan hesap.
    let ix = r.bind_ix(&r.institution.key.pubkey(), &job, r.agent.record, &p);
    r.w.h
        .send(&[compute_unit_limit(CU_LIMIT), ix], &[&key])
        .expect_err("policy hesabı değil")
        .assert_error(anchor_error(VerifierError::InvalidLinkedAccount));
}

#[test]
fn a_proof_binds_only_to_a_delivered_job_within_the_clock_tolerance() {
    let mut r = ReleaseWorld::new(true);
    // Kabul edilmiş ama teslim edilmemiş iş.
    let spec_hash = r.spec("a");
    let institution = r.institution.key.insecure_clone();
    let wallet = r.agent.wallet.insecure_clone();
    let ix = r.w.create_job_ix(
        &institution.pubkey(),
        r.agent.record,
        Some(r.policy),
        spec_hash,
        r.amount("a"),
        r.w.h.now() + 7 * DAY,
        CHALLENGE,
        r.w.usdc,
    );
    r.w.h.send(&[ix], &[&institution]).expect("create_job");
    let job = r.job_address("a");
    let ix = r.w.fund_job_ix(&r.institution, &job);
    r.w.h.send(&[ix], &[&institution]).expect("fund_job");
    let p = r.proof("compliant");
    r.bind(&job, &p)
        .expect_err("fonlanmış iş")
        .assert_error(anchor_error(VerifierError::InvalidJobState));

    r.preflight(&job, "a");
    let ix =
        r.w.accept_ix(&wallet.pubkey(), &job, r.agent.record, spec_hash);
    r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
    let ix =
        r.w.submit_ix(&wallet.pubkey(), &job, r.agent.record, DELIVERY_URI);
    r.w.h.send(&[ix], &[&wallet]).expect("submit_work");

    // İspatın anı zincirin saatine tolerans içinde yakın olmalı.
    for offset in [CLOCK_TOLERANCE_SECS + 1, -(CLOCK_TOLERANCE_SECS + 1)] {
        r.w.h.set_time(p.timestamp + offset);
        r.bind(&job, &p)
            .expect_err("tolerans dışında")
            .assert_error(anchor_error(VerifierError::StaleProof));
    }
    r.w.h.set_time(p.timestamp + CLOCK_TOLERANCE_SECS);
    r.bind(&job, &p).expect("tolerans sınırında");
}

#[test]
fn a_bought_claim_routes_the_proof_to_the_buyer() {
    let mut r = ReleaseWorld::new(true);
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());
    let buyer = r.sell_claim_to_fixture_buyer(&job);

    r.bind(&job, &r.proof("compliant"))
        .expect_err("agent'a yapılmış ispat")
        .assert_error(anchor_error(VerifierError::InvalidProof));
    let executed = r
        .bind(&job, &r.proof("buyer_payee"))
        .expect("alıcıya ispat");
    assert_eq!(r.release_proof(&job).payee, buyer);
    assert_eq!(event::<ComplianceProofSet>(&executed).payee, buyer);
}

#[test]
fn a_release_consumes_the_proof_and_advances_the_daily_counter() {
    let mut r = ReleaseWorld::new(false);
    let job_a = r.delivered_job("a");
    let job_b = r.delivered_job("b");
    r.w.h.set_time(r.proof_time());
    let a = r.proof("compliant");
    let b = r.proof("job_b");
    r.bind(&job_a, &a).expect("A");
    r.bind(&job_b, &b).expect("B");
    assert_eq!(r.fresh_at_release(&job_a, r.facts(a.net_amount)), Ok(()));

    // Yalnızca escrow'un CPI imzacısı.
    let stranger = Keypair::new();
    let ix = r.record_ix(&job_b, stranger.pubkey());
    r.w.h
        .send(&[ix], &[&stranger])
        .expect_err("escrow değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    let executed = r.record(&job_b).expect("record_release B");
    cu::within("verifier.record_release", &executed, 20_000);
    assert!(r.release_proof(&job_b).consumed);
    let state = r.operator_state();
    assert_eq!(state.daily_spent, b.net_amount);
    assert_eq!(state.total_lifetime_payments, 1);
    let recorded: ReleaseRecorded = event(&executed);
    assert_eq!(
        (
            recorded.job,
            recorded.institution,
            recorded.net_amount,
            recorded.daily_spent
        ),
        (job_b, r.policy.institution, b.net_amount, b.net_amount)
    );
    assert_eq!(recorded.day_start_unix, day_start(r.w.h.now()));

    // B'nin release'i günün sayacını ilerletti: sayaç 0'a göre yapılmış A ispatı bayat.
    assert_eq!(
        r.fresh_at_release(&job_a, r.facts(a.net_amount)),
        Err(Staleness::DailyCounter)
    );
    r.record(&job_a)
        .expect_err("bayat ispat")
        .assert_error(anchor_error(VerifierError::StaleProof));
    // Tüketilmiş ispat yeniden kullanılamaz, yeniden bağlanamaz.
    r.record(&job_b)
        .expect_err("ikinci release")
        .assert_error(anchor_error(VerifierError::ProofAlreadyConsumed));
    r.bind(&job_b, &b)
        .expect_err("tüketilmiş")
        .assert_error(anchor_error(VerifierError::ProofAlreadyConsumed));

    // Kurum A için güncel sayaçla yeni ispat bağlar; release geçer ve sayaç ilerler.
    let current = r.proof("after_job_b");
    assert_eq!(current.daily_spent_before, b.net_amount);
    r.bind(&job_a, &current).expect("güncel ispat");
    assert_eq!(
        r.fresh_at_release(&job_a, r.facts(current.net_amount)),
        Ok(())
    );
    r.record(&job_a).expect("record_release A");
    assert_eq!(
        r.operator_state().daily_spent,
        b.net_amount + current.net_amount
    );
    assert_eq!(r.operator_state().total_lifetime_payments, 2);
}

#[test]
fn a_proof_of_yesterday_or_for_another_payee_or_amount_is_stale_at_release() {
    let mut r = ReleaseWorld::new(false);
    let job = r.delivered_job("a");
    r.w.h.set_time(r.proof_time());
    let p = r.proof("compliant");
    r.bind(&job, &p).expect("bağlama");

    let other = ReleaseFacts {
        payee: Pubkey::new_unique(),
        ..r.facts(p.net_amount)
    };
    assert_eq!(r.fresh_at_release(&job, other), Err(Staleness::Payee));
    assert_eq!(
        r.fresh_at_release(&job, r.facts(p.net_amount - 1)),
        Err(Staleness::NetAmount)
    );

    // Gün değişti: sayaç 0'a döner, ama ispat dünün anına ve sayacına göre yapıldı.
    r.w.h.set_time(day_start(p.timestamp) + DAY);
    assert_eq!(
        r.fresh_at_release(&job, r.facts(p.net_amount)),
        Err(Staleness::Day)
    );
    r.record(&job)
        .expect_err("dünün ispatı")
        .assert_error(anchor_error(VerifierError::StaleProof));
}

#[test]
fn a_refused_release_consumes_the_proof_without_moving_the_counter() {
    let mut r = ReleaseWorld::new(false);
    // Kalıcı ret (ADR 0028'den sonra): alacak kurumun politikasında engelli alıcıya satıldı.
    let job = r.delivered_job("a");
    r.sell_claim_to_blocked_buyer(&job);
    r.w.h.set_time(r.proof_time());
    r.bind(&job, &r.proof("refused_blocked_buyer"))
        .expect("ret ispatı");
    let executed = r.record(&job).expect("record_release");
    assert!(r.release_proof(&job).consumed);
    let state = r.operator_state();
    assert_eq!((state.daily_spent, state.total_lifetime_payments), (0, 0));
    let recorded: ReleaseRecorded = event(&executed);
    assert_eq!((recorded.net_amount, recorded.daily_spent), (0, 0));
}
