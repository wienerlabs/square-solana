//! square_escrow `finalize_payment`, policy'siz işler (BC-23, BC-26, BC-27): challenge penceresi kapanınca
//! herkes işi kapatır ve keeper ücretini alır; net payee'ye (satılmış alacakta alıcıya) gider, payee'nin
//! screening'i temiz ve taze değilse ödeme bekler; itibar her zaman agent kaydına yazılır, her release bir
//! validation kaydı bırakır. Policy'li işlerin ispat kapısı `release_gate.rs`'te.

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, ClaimStatus, JobStatus, ValidationOutcome, ValidationRecord,
};
use square_escrow::{Finalized, ReleaseVerified, ReputationRecorded, ValidationRecorded};
use square_program_tests::{anchor_error, cu, event};
use square_registry::ScreeningStatus;

const LAMPORTS: u64 = 1_000_000_000;
/// `params()`: 50 bps.
const FEE: u64 = AMOUNT * 50 / 10_000;
const NET: u64 = AMOUNT - FEE;

#[test]
fn anyone_finalizes_after_the_window_and_the_keeper_is_paid() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    let challenge_end = w.job(&job).challenge_end;

    w.h.set_time(challenge_end - 1);
    w.finalize(&keeper, &job, settlement)
        .expect_err("pencerenin son saniyesi")
        .assert_error(anchor_error(EscrowError::ChallengePeriodNotExpired));

    w.h.set_time(challenge_end);
    let vault = vault_address(&job);
    let vault_rent = w.h.lamports(&vault);
    let rent_payer = w.job(&job).rent_payer;
    let rent_payer_before = w.h.lamports(&rent_payer);
    let executed = w
        .finalize(&keeper, &job, settlement)
        .expect("finalize_payment");
    cu::within("escrow.finalize_payment (gate yok)", &executed, 80_000);

    assert_eq!(w.balance(&settlement.keeper_token_account), Some(FEE));
    assert_eq!(w.balance(&settlement.payee_token_account), Some(NET));
    assert_eq!(w.balance(&vault), None, "vault kapandı");
    // Rent'i ödeyen sponsor, harness'ta işlem ücretini de ödüyor (payer ve keeper imzası).
    let tx_fee = 2 * 5_000;
    assert_eq!(
        w.h.lamports(&rent_payer),
        rent_payer_before + vault_rent - tx_fee
    );
    let settled = w.job(&job);
    assert_eq!(
        (settled.status, settled.settled_at),
        (JobStatus::Released, challenge_end)
    );

    let finalized: Finalized = event(&executed);
    assert_eq!(
        (finalized.job, finalized.keeper, finalized.keeper_fee),
        (job, keeper.pubkey(), FEE)
    );
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (
            verified.job,
            verified.payee,
            verified.net_amount,
            verified.release_proof
        ),
        (job, agent.wallet.pubkey(), NET, None)
    );

    // Gate'siz release'in kaydı: itibar agent kaydına, validation NoGate.
    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(reputation.agent_record, agent.record);
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, NET)
    );
    assert_eq!(
        (reputation.first_job_at, reputation.last_job_at),
        (challenge_end, challenge_end)
    );
    let recorded: ReputationRecorded = event(&executed);
    assert_eq!(
        (recorded.agent_record, recorded.job, recorded.jobs_completed),
        (agent.record, job, 1)
    );
    let validation: ValidationRecord = w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (validation.job, validation.agent_record),
        (job, agent.record)
    );
    assert_eq!(
        (validation.outcome, validation.refusal_code),
        (ValidationOutcome::NoGate, 0)
    );
    assert_eq!((validation.policy, validation.release_proof), (None, None));
    assert_eq!(validation.recorded_at, challenge_end);
    assert_eq!(
        event::<ValidationRecorded>(&executed).outcome,
        ValidationOutcome::NoGate
    );
    // Rent'i keeper öder (validation ve ilk itibar PDA'ları); kurum ve agent lamport tutmaz.
    assert!(w.h.lamports(&keeper.pubkey()) < LAMPORTS);
    assert_eq!(w.h.lamports(&institution.key.pubkey()), 0);
}

#[test]
fn a_job_settles_once_and_only_when_delivered() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.accepted_job();
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.finalize(&keeper, &job, settlement)
        .expect_err("teslim edilmemiş iş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    let ix = w.submit_ix(
        &agent.wallet.pubkey(),
        &job,
        agent.record,
        "ipfs://delivery",
    );
    let wallet = agent.wallet.insecure_clone();
    w.h.send(&[ix], &[&wallet]).expect("submit_work");
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&keeper, &job, settlement).expect("ilk finalize");
    let other_keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &other_keeper.pubkey(), agent.wallet.pubkey());
    w.finalize(&other_keeper, &job, settlement)
        .expect_err("ikinci finalize")
        .assert_error(anchor_error(AnchorErrorCode::AccountNotInitialized));
    assert_eq!(w.balance(&settlement.keeper_token_account), Some(0));
    assert_eq!(w.balance(&settlement.payee_token_account), Some(NET));
}

#[test]
fn the_keeper_may_be_the_agent_the_institution_or_the_rent_payer() {
    // Keeper agent'ın kendisi: ücret ve net aynı token hesabına.
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.h.svm.airdrop(&agent.wallet.pubkey(), LAMPORTS).unwrap();
    let settlement = w.settlement(&institution, &agent.wallet.pubkey(), agent.wallet.pubkey());
    assert_eq!(
        settlement.keeper_token_account,
        settlement.payee_token_account
    );
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&agent.wallet, &job, settlement)
        .expect("agent keeper");
    assert_eq!(w.balance(&settlement.payee_token_account), Some(AMOUNT));

    // Keeper kurumun kendisi: ücret kurumun token hesabına.
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.h.svm
        .airdrop(&institution.key.pubkey(), LAMPORTS)
        .unwrap();
    let settlement = w.settlement(
        &institution,
        &institution.key.pubkey(),
        agent.wallet.pubkey(),
    );
    assert_eq!(settlement.keeper_token_account, institution.token_account);
    let before = w.balance(&institution.token_account).unwrap();
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&institution.key, &job, settlement)
        .expect("kurum keeper");
    assert_eq!(w.balance(&institution.token_account), Some(before + FEE));
    assert_eq!(w.balance(&settlement.payee_token_account), Some(NET));

    // Keeper, rent'i ödemiş sponsorun kendisi (rent_payer).
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let sponsor = w.h.payer.insecure_clone();
    assert_eq!(w.job(&job).rent_payer, sponsor.pubkey());
    let settlement = w.settlement(&institution, &sponsor.pubkey(), agent.wallet.pubkey());
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&sponsor, &job, settlement)
        .expect("rent_payer keeper");
    assert_eq!(w.balance(&settlement.keeper_token_account), Some(FEE));
}

#[test]
fn a_zero_fee_pays_the_whole_amount_and_accounts_are_checked() {
    let mut w = World::new(true);
    let admin = w.admin.insecure_clone();
    let ix = w.update_params_ix(
        &admin.pubkey(),
        square_escrow::EscrowParams {
            keeper_fee_bps: 0,
            ..params()
        },
    );
    w.h.send(&[ix], &[&admin]).expect("update_params");
    let (institution, agent, job) = w.delivered_job();
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.h.set_time(w.job(&job).challenge_end);

    let stranger = w.h.funded(LAMPORTS);
    let cases = [
        (
            "başkasının hesabına ödeme",
            Settlement {
                payee_token_account: settlement.keeper_token_account,
                ..settlement
            },
            EscrowError::AgentMismatch,
        ),
        (
            "keeper'ın olmayan token hesabı",
            Settlement {
                keeper_token_account: token_ata(&mut w, &stranger.pubkey()),
                ..settlement
            },
            EscrowError::Unauthorized,
        ),
        (
            "kurumun olmayan iade hesabı",
            Settlement {
                institution_token_account: settlement.keeper_token_account,
                ..settlement
            },
            EscrowError::Unauthorized,
        ),
    ];
    for (label, s, error) in cases {
        w.finalize(&keeper, &job, s)
            .expect_err(label)
            .assert_error(anchor_error(error));
    }
    // Sahte vault: job'a ait ama kanonik PDA olmayan boş bir token hesabı.
    let decoy = token_ata(&mut w, &job);
    let mut ix = w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    ix.accounts[3].pubkey = decoy;
    w.h.send(&[ix], &[&keeper])
        .expect_err("sahte vault")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));

    let executed = w
        .finalize(&keeper, &job, settlement)
        .expect("finalize_payment");
    assert_eq!(event::<Finalized>(&executed).keeper_fee, 0);
    assert_eq!(w.balance(&settlement.keeper_token_account), Some(0));
    assert_eq!(w.balance(&settlement.payee_token_account), Some(AMOUNT));
}

fn token_ata(w: &mut World, owner: &Pubkey) -> Pubkey {
    let usdc = w.usdc;
    square_program_tests::token::create_ata(&mut w.h, owner, &usdc)
}

#[test]
fn a_sold_claim_pays_the_buyer_but_reputation_goes_to_the_agent() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let buyer = w.buyer(CLAIM_PRICE);
    w.sell_claim(&agent, &job, &buyer);
    let buyer = buyer.key.pubkey();
    let keeper = w.h.funded(LAMPORTS);
    w.h.set_time(w.job(&job).challenge_end);

    // Ödeme alıcıya gitmeli; agent'ın hesabı reddedilir.
    let to_agent = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.finalize(&keeper, &job, to_agent)
        .expect_err("alacak satıldı")
        .assert_error(anchor_error(EscrowError::ClaimListingRequired));

    let settlement = w.settlement(&institution, &keeper.pubkey(), buyer);
    let executed = w
        .finalize(&keeper, &job, settlement)
        .expect("alıcıya ödeme");
    assert_eq!(w.balance(&settlement.payee_token_account), Some(NET));
    // Agent'a yalnızca satış fiyatı gitti; escrow'un neti alıcıya.
    assert_eq!(w.balance(&to_agent.payee_token_account), Some(CLAIM_PRICE));
    assert_eq!(event::<ReleaseVerified>(&executed).payee, buyer);
    assert_eq!(w.claim(&job).status, ClaimStatus::Settled);
    // İtibar ve validation alıcıya değil, işi yapan agent kaydına.
    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, NET)
    );
    let validation: ValidationRecord = w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(validation.agent_record, agent.record);
}

#[test]
fn an_unscreened_payee_waits_and_is_paid_once_cleared() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    w.h.set_time(w.job(&job).challenge_end);

    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Flagged);
    w.finalize(&keeper, &job, settlement)
        .expect_err("işaretli payee")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
    w.h.set_time(w.h.now() + SCREENING_TTL);
    w.finalize(&keeper, &job, settlement)
        .expect_err("bayat kayıt")
        .assert_error(anchor_error(EscrowError::ScreeningExpired));
    w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
    w.finalize(&keeper, &job, settlement)
        .expect("yenilenen kayıtla");
    assert_eq!(w.balance(&settlement.payee_token_account), Some(NET));

    // Satın aldıktan sonra işaretlenen alıcı.
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let buyer = w.buyer(CLAIM_PRICE);
    w.sell_claim(&agent, &job, &buyer);
    w.screen(&buyer.key.pubkey(), ScreeningStatus::Flagged);
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), buyer.key.pubkey());
    w.h.set_time(w.job(&job).challenge_end);
    w.finalize(&keeper, &job, settlement)
        .expect_err("alıcı işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    assert_eq!(w.job(&job).status, JobStatus::Delivered, "escrow bekler");
}

#[test]
fn reputation_accumulates_across_jobs_of_the_same_agent() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());
    let first_at = w.job(&job).challenge_end;
    w.h.set_time(first_at);
    w.finalize(&keeper, &job, settlement).expect("ilk iş");

    let spec = [0x61; 32];
    let ix = w.create_job_ix(
        &institution.key.pubkey(),
        agent.record,
        None,
        spec,
        AMOUNT,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        w.usdc,
    );
    let key = institution.key.insecure_clone();
    w.h.send(&[ix], &[&key]).expect("create_job");
    let second = job_address(&institution.key.pubkey(), &spec);
    let ix = w.fund_job_ix(&institution, &second);
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let wallet = agent.wallet.insecure_clone();
    let ix = w.accept_ix(&wallet.pubkey(), &second, agent.record, spec);
    w.h.send(&[ix], &[&wallet]).expect("accept_job");
    let ix = w.submit_ix(&wallet.pubkey(), &second, agent.record, "ipfs://second");
    w.h.send(&[ix], &[&wallet]).expect("submit_work");
    let second_at = w.job(&second).challenge_end;
    w.h.set_time(second_at);
    let executed = w.finalize(&keeper, &second, settlement).expect("ikinci iş");

    let reputation: AgentReputation = w.h.account(&reputation_address(&agent.record)).unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (2, 2 * NET)
    );
    assert_eq!(
        (reputation.first_job_at, reputation.last_job_at),
        (first_at, second_at)
    );
    assert_eq!(event::<ReputationRecorded>(&executed).jobs_completed, 2);
}
