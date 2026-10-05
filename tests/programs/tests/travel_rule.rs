//! square_escrow Travel Rule commitment'ı (BC-34, ADR 0015): kurum, eşiğe eşit ya da üstündeki işi
//! fonlamadan önce Travel Rule kaydının salt'lı commitment'ını job'a bağlar; commitment fonlamaya kadar
//! değiştirilebilir, sonra değişmez. Zincire yalnızca 32 baytlık commitment çıkar; kaydı ve salt'ı gören
//! taraf commitment'ı yeniden hesaplayıp job'daki değerle karşılaştırır. Commitment'ın tanımı
//! `square_common::travel_rule`'dadır ve SDK'nın vektörleriyle denetlenir (crates/square-common).

mod escrow_world;

use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use solana_keypair::Keypair;
use solana_sha256_hasher::hash;
use solana_signer::Signer;
use square_common::travel_rule::{self, NONE};
use square_escrow::errors::EscrowError;
use square_escrow::state::JobStatus;
use square_escrow::{EscrowParams, TravelRuleCommitted};
use square_program_tests::{anchor_error, cu, event, Executed, Outcome};

/// Örnek Travel Rule kaydının RFC 8785 kanonik JSON'u (kaydın şeması BE-23'ündür).
const RECORD: &str = r#"{"amount":"250000000","asset":"USDC","beneficiary":{"account":"agent-wallet","name":"Example Agent Operator"},"originator":{"account":"institution-wallet","name":"Example Research Ltd"}}"#;

/// Kaydın commitment'ı: kurum zincir dışında hesaplar.
fn commitment_of(job: &Pubkey, salt: &[u8; 32], record: &str) -> [u8; 32] {
    travel_rule::commitment(job, salt, &hash(record.as_bytes()).to_bytes())
}

fn commit(w: &mut World, signer: &Keypair, job: &Pubkey, commitment: [u8; 32]) -> Outcome {
    let ix = w.commit_travel_rule_ix(&signer.pubkey(), job, commitment);
    w.h.send(&[ix], &[signer])
}

fn set_threshold(w: &mut World, travel_rule_threshold: u64) {
    let admin = w.admin.insecure_clone();
    let ix = w.update_params_ix(
        &admin.pubkey(),
        EscrowParams {
            travel_rule_threshold,
            ..params()
        },
    );
    w.h.send(&[ix], &[&admin]).expect("update_params");
}

fn fund(w: &mut World, institution: &Institution, job: &Pubkey) -> Outcome {
    let ix = w.fund_job_ix(institution, job);
    w.h.send(&[ix], &[&institution.key])
}

#[test]
fn the_commitment_is_bound_before_funding_and_replaceable_until_then() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let first = commitment_of(&job, &[0x11; 32], RECORD);

    let executed: Executed =
        commit(&mut w, &institution.key, &job, first).expect("commit_travel_rule");
    cu::within("escrow.commit_travel_rule", &executed, 10_000);
    let committed: TravelRuleCommitted = event(&executed);
    assert_eq!((committed.job, committed.commitment), (job, first));
    assert_eq!(w.job(&job).travel_rule_commitment, first);

    // Fonlamadan önce düzeltilebilir: son bağlanan geçerlidir.
    let corrected = commitment_of(&job, &[0x22; 32], RECORD);
    commit(&mut w, &institution.key, &job, corrected).expect("düzeltme");
    assert_eq!(w.job(&job).travel_rule_commitment, corrected);

    // Fonlandıktan sonra değişmez.
    fund(&mut w, &institution, &job).expect("fund_job");
    assert_eq!(w.job(&job).status, JobStatus::Funded);
    commit(&mut w, &institution.key, &job, first)
        .expect_err("fonlanmış iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
    assert_eq!(w.job(&job).travel_rule_commitment, corrected);
}

#[test]
fn funding_at_or_above_the_threshold_needs_a_commitment() {
    // Eşik tutara eşit: commitment gerekir.
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    set_threshold(&mut w, AMOUNT);
    fund(&mut w, &institution, &job)
        .expect_err("commitment yok")
        .assert_error(anchor_error(EscrowError::TravelRuleCommitmentRequired));
    commit(
        &mut w,
        &institution.key,
        &job,
        commitment_of(&job, &[0x33; 32], RECORD),
    )
    .expect("commit_travel_rule");
    fund(&mut w, &institution, &job).expect("commitment'la");

    // Eşiğin altı ve kapalı eşik (0): commitment gerekmez.
    for threshold in [AMOUNT + 1, 0] {
        let mut w = World::new(true);
        let (institution, _agent, job) = w.open_job(false);
        set_threshold(&mut w, threshold);
        fund(&mut w, &institution, &job).expect("commitment'sız");
        assert_eq!(w.job(&job).travel_rule_commitment, NONE);
    }
}

#[test]
fn only_the_job_institution_binds_a_non_zero_commitment() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let stranger = w.institution(0);
    commit(
        &mut w,
        &stranger.key,
        &job,
        commitment_of(&job, &[0x44; 32], RECORD),
    )
    .expect_err("başka kurum")
    .assert_error(anchor_error(EscrowError::Unauthorized));
    // Sıfır "commitment yok" demektir; bağlanamaz.
    commit(&mut w, &institution.key, &job, NONE)
        .expect_err("sıfır commitment")
        .assert_error(anchor_error(EscrowError::TravelRuleCommitmentRequired));
    assert_eq!(w.job(&job).travel_rule_commitment, NONE);
}

#[test]
fn no_personal_data_reaches_the_chain_and_the_commitment_verifies() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let salt = [0x5a; 32];
    let commitment = commitment_of(&job, &salt, RECORD);
    let ix = w.commit_travel_rule_ix(&institution.key.pubkey(), &job, commitment);
    // Talimatın verisi ayırıcı ve 32 baytlık commitment'tır.
    assert_eq!(ix.data.len(), 8 + 32);
    let executed =
        w.h.send(&[ix], &[&institution.key])
            .expect("commit_travel_rule");

    // Kaydın hiçbir alanı hesapta ya da loglarda yok.
    let account = w.h.raw_account(&job).expect("job").data;
    let logs = executed.logs.join("\n");
    for field in [
        "Example Research Ltd",
        "Example Agent Operator",
        "institution-wallet",
    ] {
        let bytes = field.as_bytes();
        assert!(
            !account.windows(bytes.len()).any(|window| window == bytes),
            "{field} hesapta"
        );
        assert!(!logs.contains(field), "{field} loglarda");
    }

    // Kaydı ve salt'ı gören taraf commitment'ı doğrular; başka salt, kayıt ya da iş tutmaz.
    let bound = w.job(&job).travel_rule_commitment;
    assert_eq!(commitment_of(&job, &salt, RECORD), bound);
    assert_ne!(commitment_of(&job, &[0x5b; 32], RECORD), bound);
    assert_ne!(
        commitment_of(&job, &salt, &RECORD.replace("250000000", "250000001")),
        bound
    );
    assert_ne!(commitment_of(&Pubkey::new_unique(), &salt, RECORD), bound);
}
