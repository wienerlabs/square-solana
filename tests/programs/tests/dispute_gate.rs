//! Policy'li işte uyuşmazlık (BC-32, BC-33; ADR 0016). Kararın agent tarafına ödediği tutar
//! `finalize_payment`'le aynı ispat kapısından geçer, keeper ücreti yoktur: FavorAgent'ta tam tutar,
//! Split'te agent payı. İspat karardan sonra (`Resolved`) bağlanır. Kurum ispatı bağlamazsa ya da ret
//! geçiciyse agent `escalate_missing_proof` ile bond'suz dispute açar. İspatlar gerçek Groth16
//! ispatlarıdır (`fixtures/release-proofs.json`, `dispute_*` senaryoları).

mod escrow_world;
mod release_world;

use escrow_world::*;
use release_world::*;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, DisputeResolution, JobStatus, ValidationOutcome, ValidationRecord,
};
use square_escrow::{
    DisputeRaised, DisputeResolved, MissingProofEscalated, ReleaseRefused, ReleaseVerified,
};
use square_program_tests::{anchor_error, compute_unit_limit, cu, event, Outcome};

const LAMPORTS: u64 = 1_000_000_000;

/// `max(amount × 5%, 1 USDC)` (`params()`).
fn min_bond(amount: u64) -> u64 {
    (amount / 20).max(1_000_000)
}

fn execute(
    r: &mut ReleaseWorld,
    payer: &solana_keypair::Keypair,
    job: &anchor_lang::prelude::Pubkey,
    settlement: Settlement,
) -> Outcome {
    let ix =
        r.w.execute_ix(&payer.pubkey(), job, settlement, Some(r.gate(job)));
    r.w.h.send(&[compute_unit_limit(CU_LIMIT), ix], &[payer])
}

/// `spec` işi teslim edildi, kurum pencere içinde itiraz etti, panel `resolution`'a karar verdi; saat
/// ispatların anında.
fn resolved(
    r: &mut ReleaseWorld,
    spec: &str,
    resolution: DisputeResolution,
) -> anchor_lang::prelude::Pubkey {
    let job = r.delivered_job(spec);
    let bond = min_bond(r.amount(spec));
    let institution = Institution {
        key: r.institution.key.insecure_clone(),
        token_account: r.institution.token_account,
    };
    r.w.raise_dispute(&institution, &job, bond)
        .expect("raise_dispute");
    r.w.decide(&job, resolution);
    assert_eq!(r.w.job(&job).status, JobStatus::Resolved);
    r.w.h.set_time(r.proof_time());
    job
}

#[test]
fn favor_agent_on_a_policy_job_pays_the_full_amount_against_a_fresh_proof() {
    let mut r = ReleaseWorld::new(false);
    let job = resolved(&mut r, "a", DisputeResolution::FavorAgent);
    let amount = r.amount("a");
    let caller = r.w.h.funded(LAMPORTS);
    let settlement = r.settlement(&caller, r.agent.wallet.pubkey());

    execute(&mut r, &caller, &job, settlement)
        .expect_err("ispat yok")
        .assert_error(anchor_error(EscrowError::ProofRequired));
    // Keeper ücretli finalize netinin ispatı kararın tutarına uymaz.
    r.bind(&job, &r.proof("compliant"))
        .expect("finalize netinin ispatı");
    execute(&mut r, &caller, &job, settlement)
        .expect_err("net farklı")
        .assert_error(anchor_error(EscrowError::StaleReleaseProof));

    // Karar sonrası (Resolved) kurum ispatı tam tutarla yeniden bağlar.
    r.bind(&job, &r.proof("dispute_favor_agent"))
        .expect("Resolved işe ispat");
    let executed = execute(&mut r, &caller, &job, settlement).expect("execute_resolution");
    // Profilde yok: 200 ölçümün en yükseğinin (95 989) iki katı, 10 bine yukarı yuvarlanmış (profilin kuralı).
    cu::within(
        "escrow.execute_resolution (ispat kapısı)",
        &executed,
        200_000,
    );

    let bond = min_bond(amount);
    assert_eq!(
        r.w.balance(&settlement.payee_token_account),
        Some(amount + bond)
    );
    assert_eq!(r.w.job(&job).status, JobStatus::Released);
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (verified.net_amount, verified.release_proof),
        (amount, Some(release_proof_address(&job)))
    );
    assert!(r.release_proof(&job).consumed, "ispat tüketildi");
    assert_eq!(
        r.operator_state().daily_spent,
        amount,
        "günlük sayaç ilerledi"
    );
    let validation: ValidationRecord = r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(validation.outcome, ValidationOutcome::Verified);
}

#[test]
fn a_split_needs_a_proof_of_the_agent_share() {
    let mut r = ReleaseWorld::new(false);
    let share = 10_000_000;
    let job = resolved(
        &mut r,
        "a",
        DisputeResolution::Split {
            agent_amount: share,
        },
    );
    let amount = r.amount("a");
    let caller = r.w.h.funded(LAMPORTS);
    let settlement = r.settlement(&caller, r.agent.wallet.pubkey());
    let institution_before = r.w.balance(&r.institution.token_account).unwrap();

    r.bind(&job, &r.proof("dispute_split")).expect("pay ispatı");
    let executed = execute(&mut r, &caller, &job, settlement).expect("execute_resolution");
    assert_eq!(r.w.balance(&settlement.payee_token_account), Some(share));
    // İade: escrow'un geri kalanı ve bond.
    assert_eq!(
        r.w.balance(&r.institution.token_account),
        Some(institution_before + amount - share + min_bond(amount))
    );
    let resolved: DisputeResolved = event(&executed);
    assert_eq!(
        (resolved.agent_side_amount, resolved.institution_refund),
        (share, amount - share)
    );
}

#[test]
fn a_final_refusal_refunds_the_award_but_the_bond_stays_a_penalty() {
    let mut r = ReleaseWorld::new(false);
    let job = resolved(&mut r, "c", DisputeResolution::FavorAgent);
    let amount = r.amount("c");
    let bond = min_bond(amount);
    let caller = r.w.h.funded(LAMPORTS);
    let settlement = r.settlement(&caller, r.agent.wallet.pubkey());
    let institution_before = r.w.balance(&r.institution.token_account).unwrap();

    r.bind(&job, &r.proof("dispute_refused_per_tx"))
        .expect("kalıcı ret");
    let executed = execute(&mut r, &caller, &job, settlement).expect("execute_resolution");
    // Escrow kapıdan geçmez ve kuruma döner; bond cezadır, kapıdan geçmeden agent tarafına kesilir.
    assert_eq!(r.w.balance(&settlement.payee_token_account), Some(bond));
    assert_eq!(
        r.w.balance(&r.institution.token_account),
        Some(institution_before + amount)
    );
    assert_eq!(r.w.job(&job).status, JobStatus::Refunded);
    let refused: ReleaseRefused = event(&executed);
    assert_eq!((refused.refusal_code, refused.refunded_amount), (1, amount));
    let validation: ValidationRecord = r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (validation.outcome, validation.refusal_code),
        (ValidationOutcome::Refused, 1)
    );
    let reputation: AgentReputation = r.w.h.account(&reputation_address(&r.agent.record)).unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.jobs_disputed),
        (0, 1)
    );
}

#[test]
fn the_agent_escalates_a_missing_proof_after_the_timeout() {
    let mut w = World::new(true);
    // Policy'siz işte ispat kapısı yoktur.
    let (_institution, agent, plain) = w.delivered_job();
    w.h.set_time(w.job(&plain).challenge_end + DAY);
    w.escalate(&agent.wallet, &plain)
        .expect_err("policy'siz iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job_with(true);
    let ready_at = w.job(&job).challenge_end + params().proof_timeout_secs;
    w.h.set_time(ready_at - 1);
    w.escalate(&agent.wallet, &job)
        .expect_err("süre dolmadı")
        .assert_error(anchor_error(EscrowError::ProofTimeoutNotReached));
    w.h.set_time(ready_at);
    let intruder = w.h.funded(LAMPORTS);
    w.escalate(&intruder, &job)
        .expect_err("agent değil")
        .assert_error(anchor_error(EscrowError::AgentMismatch));

    let executed = w
        .escalate(&agent.wallet, &job)
        .expect("escalate_missing_proof");
    // Profilde yok: 200 ölçümün en yükseğinin (23 540) iki katı, 10 bine yukarı yuvarlanmış (profilin kuralı).
    cu::within("escrow.escalate_missing_proof", &executed, 50_000);
    let escalated: MissingProofEscalated = event(&executed);
    assert_eq!(
        (escalated.job, escalated.agent_wallet),
        (job, agent.wallet.pubkey())
    );
    let raised: DisputeRaised = event(&executed);
    assert_eq!((raised.challenger, raised.bond), (agent.wallet.pubkey(), 0));
    let state = w.job(&job);
    assert_eq!(state.status, JobStatus::Disputed);
    assert_eq!(
        (state.dispute.challenger, state.dispute.bond),
        (agent.wallet.pubkey(), 0)
    );
    assert_eq!(w.bond_vault(&job), None, "bond'suz dispute");
    w.escalate(&agent.wallet, &job)
        .expect_err("açık dispute")
        .assert_error(anchor_error(EscrowError::DisputeAlreadyActive));

    // Panel karar vermezse dispute düşer; bond yoktur.
    let deadline = state.dispute.deadline;
    w.h.set_time(deadline);
    let caller = w.h.funded(LAMPORTS);
    let lapsed = w
        .lapse(&caller, &job, institution.token_account)
        .expect("lapse_dispute");
    assert_eq!(
        event::<square_escrow::DisputeLapsed>(&lapsed).bond_refunded,
        0
    );
    assert_eq!(w.job(&job).status, JobStatus::Delivered);

    // Lapse'tan sonra agent başvuruyu, bekleme süresi yeniden dolunca tekrarlayabilir.
    w.escalate(&agent.wallet, &job)
        .expect_err("lapse'tan sonra bekleme")
        .assert_error(anchor_error(EscrowError::ProofTimeoutNotReached));
    w.h.set_time(deadline + params().proof_timeout_secs);
    w.escalate(&agent.wallet, &job).expect("ikinci başvuru");
    let state = w.job(&job);
    assert!(!state.dispute.lapsed);

    // Panel kurum lehine karar verirse escrow kuruma döner; bond vault'u yoktur.
    w.decide(&job, DisputeResolution::FavorInstitution);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());
    let executed = w
        .execute(&caller, &job, settlement)
        .expect("execute_resolution");
    let resolved: DisputeResolved = event(&executed);
    assert_eq!(
        (
            resolved.institution_refund,
            resolved.bond_returned,
            resolved.bond_to_agent_side
        ),
        (AMOUNT, 0, 0)
    );
    assert_eq!(w.balance(&institution.token_account), Some(10 * AMOUNT));
}

#[test]
fn escalation_waits_while_a_bound_proof_can_settle_the_job_today() {
    let mut r = ReleaseWorld::new(false);
    // Bekleme süresi 0: başvuru challenge penceresi kapanır kapanmaz mümkün.
    let mut p = params();
    p.proof_timeout_secs = 0;
    let admin = r.w.admin.insecure_clone();
    let ix = r.w.update_params_ix(&admin.pubkey(), p);
    r.w.h.send(&[ix], &[&admin]).expect("update_params");
    let job = r.delivered_job("a");
    let wallet = r.agent.wallet.insecure_clone();

    // Bugün uyumlu bir ispat varsa iş finalize edilebilir: başvuru reddedilir.
    r.w.h.set_time(r.proof_time());
    r.bind(&job, &r.proof("compliant")).expect("uyumlu ispat");
    r.w.escalate(&wallet, &job)
        .expect_err("ispat işi kapatabilir")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    // Geçici ret (zaman penceresi dışı) escrow'u bekletir: başvuru açılır.
    r.w.h.set_time(r.proof_time() + 4 * HOUR);
    r.bind(&job, &r.proof("refused_time_window"))
        .expect("geçici ret");
    r.w.escalate(&wallet, &job).expect("geçici retle başvuru");
}

#[test]
fn a_proof_from_another_day_does_not_block_the_escalation() {
    let mut r = ReleaseWorld::new(false);
    let mut p = params();
    p.proof_timeout_secs = 0;
    let admin = r.w.admin.insecure_clone();
    let ix = r.w.update_params_ix(&admin.pubkey(), p);
    r.w.h.send(&[ix], &[&admin]).expect("update_params");
    let job = r.delivered_job("a");
    let wallet = r.agent.wallet.insecure_clone();
    r.w.h.set_time(r.proof_time());
    r.bind(&job, &r.proof("compliant")).expect("uyumlu ispat");

    // Ertesi gün ispat bayattır; kurum yenilemezse escrow süresiz beklerdi.
    let next_day = r.proof_time() - r.proof_time().rem_euclid(DAY) + DAY;
    r.w.h.set_time(next_day);
    r.w.escalate(&wallet, &job).expect("bayat ispatla başvuru");
}
