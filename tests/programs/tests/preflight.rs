//! Kabul öncesi uyum ön-ispatı (P-01, ADR 0028 madde 1 ve 2): kurum, agent kabul etmeden önce policy'li işin kendi
//! koşullarıyla (net = tutar, payee = agent cüzdanı, sayaç 0) kalıcı ya da günlük tavan biti olmadan geçtiğini
//! verifier'ın `set_preflight_proof`'uyla kanıtlar; escrow `accept_job`'da bu `PreflightProof`'u ister. Public
//! tavanı aşan iş hiç açılmaz.
//!
//! İspatlar gerçek Groth16 ispatlarıdır (tests/fixtures/release-proofs.json, `preflight_<iş>` senaryoları); iş
//! ispatların anından iki saat önce, dünyanın saatinde kabul edilir (`release_world`).

mod escrow_world;
mod fiat_world;
mod release_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use fiat_world::*;
use release_world::*;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::JobStatus;
use square_program_tests::{anchor_error, compute_unit_limit, cu, event};
use square_verifier::errors::VerifierError;
use square_verifier::state::PreflightProof;
use square_verifier::{PreflightProofSet, CLOCK_TOLERANCE_SECS};

/// Agent `spec` işini kabul etmeyi dener.
fn accept(r: &mut ReleaseWorld, job: &Pubkey, spec: &str) -> square_program_tests::Outcome {
    let wallet = r.agent.wallet.insecure_clone();
    let ix =
        r.w.accept_ix(&wallet.pubkey(), job, r.agent.record, r.spec(spec));
    r.w.h.send(&[ix], &[&wallet])
}

#[test]
fn a_policy_job_is_accepted_only_after_the_institutions_preflight_proof() {
    let mut r = ReleaseWorld::new(true);
    let job = r.funded_job("a");
    accept(&mut r, &job, "a")
        .expect_err("ön-ispat yok")
        .assert_error(anchor_error(EscrowError::PreflightRequired));

    let p = r.proof("preflight_a");
    assert_eq!(
        (p.refusal_code, p.net_amount, p.daily_spent_before),
        (0, r.amount("a"), 0)
    );
    let executed = r.bind_preflight(&job, &p).expect("set_preflight_proof");
    cu::within("verifier.set_preflight_proof", &executed, 200_000);
    let stored: PreflightProof =
        r.w.h
            .account(&preflight_address(&job))
            .expect("PreflightProof");
    let snapshot = r.w.job(&job);
    assert_eq!(
        (
            stored.job,
            stored.policy,
            stored.policy_commitment,
            stored.refusal_code,
            stored.proof_timestamp
        ),
        (
            job,
            r.policy.policy,
            snapshot.policy_commitment,
            0,
            p.timestamp
        )
    );
    let set: PreflightProofSet = event(&executed);
    assert_eq!(
        (set.job, set.policy, set.refusal_code, set.proof_timestamp),
        (job, r.policy.policy, 0, p.timestamp)
    );

    // Kabulden önce yeniden bağlanabilir; kabulden sonra bağlanamaz.
    r.bind_preflight(&job, &p).expect("yeniden bağlama");
    accept(&mut r, &job, "a").expect("accept_job");
    assert_eq!(r.w.job(&job).status, JobStatus::Accepted);
    r.bind_preflight(&job, &p)
        .expect_err("kabul edilmiş iş")
        .assert_error(anchor_error(VerifierError::InvalidJobState));
}

#[test]
fn a_job_whose_own_terms_break_a_permanent_rule_cannot_be_accepted() {
    let mut r = ReleaseWorld::new(true);
    // c işinin tutarı (150 USDC) politikanın işlem başı tavanını (100 USDC) aşar: geçerli ispatın ret kodu 1.
    let job = r.funded_job("c");
    let p = r.proof("preflight_c");
    assert_eq!(p.refusal_code, 1);
    r.bind_preflight(&job, &p)
        .expect_err("kalıcı ret")
        .assert_error(anchor_error(VerifierError::PreflightRefused));
    assert!(r.w.h.raw_account(&preflight_address(&job)).is_none());
    accept(&mut r, &job, "c")
        .expect_err("ön-ispat yok")
        .assert_error(anchor_error(EscrowError::PreflightRequired));

    // Başka bir işin ön-ispatı bu işin adresinde değildir.
    let other = r.funded_job("a");
    r.preflight(&other, "a");
    let wallet = r.agent.wallet.insecure_clone();
    let mut ix =
        r.w.accept_ix(&wallet.pubkey(), &job, r.agent.record, r.spec("c"));
    ix.accounts[4].pubkey = preflight_address(&other);
    r.w.h
        .send(&[ix], &[&wallet])
        .expect_err("başka işin ön-ispatı")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
}

#[test]
fn the_preflight_proof_is_checked_against_the_jobs_own_terms_and_the_clock() {
    let mut r = ReleaseWorld::new(true);
    let job = r.funded_job("a");
    let p = r.proof("preflight_a");

    // Başka bir işin ispatı (b: başka job adresi ve tutar) bu işin sinyallerini tutmaz.
    r.bind_preflight(&job, &r.proof("preflight_b"))
        .expect_err("başka işin ispatı")
        .assert_error(anchor_error(VerifierError::InvalidProof));
    // Release ispatı (net keeper ücreti düşülmüş, ispatların anında) ön-ispat değildir.
    r.w.h.set_time(r.proof_time());
    r.bind_preflight(&job, &r.proof("compliant"))
        .expect_err("release ispatı")
        .assert_error(anchor_error(VerifierError::InvalidProof));

    // İspatın anı zincirin saatine tolerans içinde yakın olmalı.
    for offset in [CLOCK_TOLERANCE_SECS + 1, -(CLOCK_TOLERANCE_SECS + 1)] {
        r.w.h.set_time(p.timestamp + offset);
        r.bind_preflight(&job, &p)
            .expect_err("tolerans dışında")
            .assert_error(anchor_error(VerifierError::StaleProof));
    }
    r.w.h.set_time(p.timestamp);

    // Yalnızca kurumun güncel yetkilisi bağlar.
    let stranger = r.w.h.funded(1_000_000_000);
    let ix = r.preflight_ix(&stranger.pubkey(), &job, r.policy.policy, &p);
    r.w.h
        .send(&[compute_unit_limit(CU_LIMIT), ix], &[&stranger])
        .expect_err("kurumun yetkilisi değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));
    r.bind_preflight(&job, &p).expect("set_preflight_proof");
}

#[test]
fn escrow_reads_only_the_verifiers_preflight_for_this_job_and_snapshot() {
    let mut r = ReleaseWorld::new(true);
    let job = r.funded_job("a");
    r.preflight(&job, "a");
    let stored: PreflightProof =
        r.w.h
            .account(&preflight_address(&job))
            .expect("PreflightProof");
    let write = |r: &mut ReleaseWorld, proof: &PreflightProof, owner: Pubkey| {
        let mut data = Vec::new();
        anchor_lang::AccountSerialize::try_serialize(proof, &mut data).expect("PreflightProof");
        r.w.h
            .set_program_account(preflight_address(&job), owner, data);
    };

    // Doğru adreste ama verifier'a ait olmayan hesap.
    write(&mut r, &stored, Pubkey::new_unique());
    accept(&mut r, &job, "a")
        .expect_err("sahibi verifier değil")
        .assert_error(anchor_error(EscrowError::LinkedProgramMismatch));
    // Verifier'ın hesabı ama başka bir commitment'a ya da işe ait.
    let other_snapshot = PreflightProof {
        policy_commitment: [0x5a; 32],
        ..stored.clone()
    };
    write(&mut r, &other_snapshot, square_verifier::ID);
    accept(&mut r, &job, "a")
        .expect_err("başka commitment")
        .assert_error(anchor_error(EscrowError::PreflightRequired));
    let other_job = PreflightProof {
        job: Pubkey::new_unique(),
        ..stored.clone()
    };
    write(&mut r, &other_job, square_verifier::ID);
    accept(&mut r, &job, "a")
        .expect_err("başka iş")
        .assert_error(anchor_error(EscrowError::PreflightRequired));

    write(&mut r, &stored, square_verifier::ID);
    accept(&mut r, &job, "a").expect("accept_job");
}

#[test]
fn a_job_above_the_public_daily_ceiling_is_not_opened() {
    // Escrow işi: politika tavanı `CEILING` (1 000 USDC).
    let mut w = World::new(true);
    let institution = w.institution(10 * CEILING);
    let agent = w.register_agent("research-agent");
    w.screen(
        &institution.key.pubkey(),
        square_registry::ScreeningStatus::Clear,
    );
    w.screen(
        &agent.wallet.pubkey(),
        square_registry::ScreeningStatus::Clear,
    );
    let policy = w.policy(&institution.key, POLICY_ID);
    let key = institution.key.insecure_clone();
    for (amount, outcome) in [(CEILING + 1, false), (CEILING, true)] {
        let spec = [amount.to_le_bytes()[0]; 32];
        let ix = w.create_job_ix(
            &key.pubkey(),
            agent.record,
            Some(policy),
            spec,
            amount,
            w.h.now() + 7 * DAY,
            CHALLENGE,
            w.usdc,
        );
        let sent = w.h.send(&[ix], &[&key]);
        if outcome {
            sent.expect("tavana eşit tutar");
        } else {
            sent.expect_err("tavanı aşan tutar")
                .assert_error(anchor_error(EscrowError::AmountAboveDailyCeiling));
        }
    }
    // Policy'siz işte tavan yoktur.
    let ix = w.create_job_ix(
        &key.pubkey(),
        agent.record,
        None,
        [0x77; 32],
        CEILING + 1,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        w.usdc,
    );
    w.h.send(&[ix], &[&key]).expect("policy'siz iş");

    // Fiat iş: fikstürün politikasının tavanı 1 000 USDC.
    let mut f = FiatWorld::new();
    let ceiling: u64 = f.r.fx["policy"]["daily_ceiling"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let ix = f.create_ix(f.r.spec(FIAT), ceiling + 1, f.r.w.h.now() + 7 * DAY);
    let institution = f.institution();
    f.r.w
        .h
        .send(&[ix], &[&institution])
        .expect_err("tavanı aşan fiat iş")
        .assert_error(anchor_error(EscrowError::AmountAboveDailyCeiling));
}

#[test]
fn a_fiat_job_needs_the_preflight_proof_too() {
    let mut f = FiatWorld::new();
    f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    let wallet = f.r.agent.wallet.insecure_clone();
    let ix =
        f.r.w
            .accept_ix(&wallet.pubkey(), &job, f.r.agent.record, f.r.spec(FIAT));
    f.r.w
        .h
        .send(std::slice::from_ref(&ix), &[&wallet])
        .expect_err("ön-ispat yok")
        .assert_error(anchor_error(EscrowError::PreflightRequired));
    f.r.preflight(&job, FIAT);
    f.r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
}
