//! Hesap ikamesi saldırıları (BC-29): settlement ve dispute talimatlarına başka bir işin vault'u, bond
//! vault'u, alacak listelemesi ya da ispatı, escrow'a ait olmayan bir job kopyası, başka bir rent alıcısı
//! ya da başka mint'in token hesabı verilir. Her biri talimat fon taşımadan reddedilir; hesapların
//! kanonik PDA'lara ve job'un alanlarına bağlı olduğu (`seeds`, `has_one`, owner) burada denenir.

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use escrow_world::*;
use solana_account::Account;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{DisputeResolution, JobStatus};
use square_program_tests::token;
use square_program_tests::{anchor_error, Outcome};

const LAMPORTS: u64 = 1_000_000_000;
const OTHER_SPEC: [u8; 32] = [0x52; 32];

/// Aynı kurum ve agent'la ikinci bir teslim edilmiş iş (`OTHER_SPEC`).
fn second_delivered_job(w: &mut World, institution: &Institution, agent: &Agent) -> Pubkey {
    let key = institution.key.insecure_clone();
    let wallet = agent.wallet.insecure_clone();
    let ix = w.create_job_ix(
        &key.pubkey(),
        agent.record,
        None,
        OTHER_SPEC,
        AMOUNT,
        w.h.now() + 7 * DAY,
        CHALLENGE,
        w.usdc,
    );
    w.h.send(&[ix], &[&key]).expect("create_job");
    let job = job_address(&key.pubkey(), &OTHER_SPEC);
    let ix = w.fund_job_ix(institution, &job);
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let ix = w.accept_ix(&wallet.pubkey(), &job, agent.record, OTHER_SPEC);
    w.h.send(&[ix], &[&wallet]).expect("accept_job");
    let ix = w.submit_ix(&wallet.pubkey(), &job, agent.record, "ipfs://other");
    w.h.send(&[ix], &[&wallet]).expect("submit_work");
    job
}

/// `index`'teki hesabı `replacement` ile değiştirip gönderir.
fn send_with(
    w: &mut World,
    mut ix: anchor_lang::solana_program::instruction::Instruction,
    index: usize,
    replacement: Pubkey,
    signer: &solana_keypair::Keypair,
) -> Outcome {
    ix.accounts[index].pubkey = replacement;
    w.h.send(&[ix], &[signer])
}

/// Hesap listesindeki konumu (talimatın `ToAccountMetas` sırası).
fn position(ix: &anchor_lang::solana_program::instruction::Instruction, address: &Pubkey) -> usize {
    ix.accounts
        .iter()
        .position(|meta| meta.pubkey == *address)
        .expect("hesap talimatta yok")
}

#[test]
fn finalize_rejects_another_jobs_claim_listing_and_rent_payer() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let other = second_delivered_job(&mut w, &institution, &agent);
    // Diğer işin alacağı satılmış: listelemesi bu işe verilip ödeme alıcıya yönlendirilemez.
    let buyer = w.buyer(CLAIM_PRICE);
    w.sell_claim(&agent, &other, &buyer);
    w.h.set_time(w.job(&job).challenge_end);
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());

    let ix = w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    let at = position(&ix, &claim_address(&job));
    send_with(&mut w, ix, at, claim_address(&other), &keeper)
        .expect_err("başka işin listelemesi")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));

    let ix = w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    let at = position(&ix, &w.job(&job).rent_payer);
    send_with(&mut w, ix, at, keeper.pubkey(), &keeper)
        .expect_err("rent başka hesaba")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    w.finalize(&keeper, &job, settlement)
        .expect("doğru hesaplarla");
    assert_eq!(
        w.job(&other).status,
        JobStatus::Delivered,
        "diğer iş etkilenmedi"
    );
}

#[test]
fn a_copy_of_a_job_outside_the_escrow_program_is_rejected() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.h.set_time(w.job(&job).challenge_end);
    let keeper = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &keeper.pubkey(), agent.wallet.pubkey());

    // Aynı baytlar, başka bir owner: Anchor hesabın escrow'a ait olmasını ister.
    let real = w.h.raw_account(&job).unwrap();
    let forged = Pubkey::new_unique();
    w.h.set_account(
        forged,
        Account {
            owner: square_registry::ID,
            ..real
        },
    );
    let ix = w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    let at = position(&ix, &job);
    send_with(&mut w, ix, at, forged, &keeper)
        .expect_err("sahte job")
        .assert_error(anchor_error(AnchorErrorCode::AccountOwnedByWrongProgram));
}

#[test]
fn execute_resolution_rejects_substituted_vaults_listings_and_mints() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let other = second_delivered_job(&mut w, &institution, &agent);
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise");
    w.raise_dispute(&institution, &other, MIN_BOND)
        .expect("raise (diğer iş)");
    w.decide(&job, DisputeResolution::FavorInstitution);
    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());

    for (ours, theirs, label) in [
        (
            vault_address(&job),
            vault_address(&other),
            "başka işin vault'u",
        ),
        (
            bond_address(&job),
            bond_address(&other),
            "başka işin bond vault'u",
        ),
        (
            claim_address(&job),
            claim_address(&other),
            "başka işin listelemesi",
        ),
        (
            validation_address(&job),
            validation_address(&other),
            "başka işin validation kaydı",
        ),
    ] {
        let ix = w.execute_ix(&caller.pubkey(), &job, settlement, None);
        let at = position(&ix, &ours);
        send_with(&mut w, ix, at, theirs, &caller)
            .expect_err(label)
            .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
    }

    // Kurumun hesabı yerine başkasının; başka mint'in hesabı.
    let stranger = w.institution(0);
    let mut wrong = settlement;
    wrong.institution_token_account = stranger.token_account;
    w.execute(&caller, &job, wrong)
        .expect_err("kurumun hesabı değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    let other_mint = token::create_usdc_mint(&mut w.h, &w.mint_authority.pubkey());
    let mut wrong = settlement;
    wrong.payee_token_account = token::create_ata(&mut w.h, &agent.wallet.pubkey(), &other_mint);
    w.execute(&caller, &job, wrong)
        .expect_err("başka mint")
        .assert_error(anchor_error(EscrowError::MintMismatch));

    // Rent başka hesaba yönlendirilemez.
    let ix = w.execute_ix(&caller.pubkey(), &job, settlement, None);
    let at = position(&ix, &w.job(&job).rent_payer);
    send_with(&mut w, ix, at, caller.pubkey(), &caller)
        .expect_err("rent başka hesaba")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    w.execute(&caller, &job, settlement)
        .expect("doğru hesaplarla");
    assert_eq!(
        w.job(&other).status,
        JobStatus::Disputed,
        "diğer iş etkilenmedi"
    );
    assert_eq!(w.balance(&bond_address(&other)), Some(MIN_BOND));
}

#[test]
fn a_bonded_dispute_cannot_settle_without_its_bond_vault() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise");
    w.decide(&job, DisputeResolution::FavorAgent);
    let caller = w.h.funded(LAMPORTS);
    let settlement = w.settlement(&institution, &caller.pubkey(), agent.wallet.pubkey());

    // Bond vault'u verilmezse bond kilitli kalacaktı: talimat reddedilir.
    let mut ix = w.execute_ix(&caller.pubkey(), &job, settlement, None);
    let at = position(&ix, &bond_address(&job));
    ix.accounts[at].pubkey = square_escrow::ID;
    ix.accounts[at].is_writable = false;
    w.h.send(&[ix], &[&caller])
        .expect_err("bond vault'u yok")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    w.execute(&caller, &job, settlement)
        .expect("bond vault'uyla");
}

#[test]
fn lapse_rejects_a_substituted_bond_vault_and_refund_target() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.delivered_job();
    let other = second_delivered_job(&mut w, &institution, &agent);
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise");
    w.raise_dispute(&institution, &other, MIN_BOND)
        .expect("raise (diğer iş)");
    w.h.set_time(w.job(&job).dispute.deadline);
    let caller = w.h.funded(LAMPORTS);

    let ix = w.lapse_ix(&caller.pubkey(), &job, institution.token_account);
    let at = position(&ix, &bond_address(&job));
    send_with(&mut w, ix, at, bond_address(&other), &caller)
        .expect_err("başka işin bond vault'u")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));

    // Bond vault'u verilmezse bond iade edilemez: talimat reddedilir.
    let mut ix = w.lapse_ix(&caller.pubkey(), &job, institution.token_account);
    let at = position(&ix, &bond_address(&job));
    ix.accounts[at].pubkey = square_escrow::ID;
    ix.accounts[at].is_writable = false;
    w.h.send(&[ix], &[&caller])
        .expect_err("bond vault'u yok")
        .assert_error(anchor_error(EscrowError::InvalidStatus));

    let ix = w.lapse_ix(&caller.pubkey(), &job, institution.token_account);
    let at = position(&ix, &w.job(&job).rent_payer);
    send_with(&mut w, ix, at, caller.pubkey(), &caller)
        .expect_err("rent başka hesaba")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    w.lapse(&caller, &job, institution.token_account)
        .expect("doğru hesaplarla");
    assert_eq!(w.balance(&bond_address(&other)), Some(MIN_BOND));
}

#[test]
fn a_dispute_cannot_be_raised_on_another_institutions_job_or_paid_from_its_account() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.delivered_job();
    let stranger = w.institution(10 * AMOUNT);

    // Başka bir kurum imzalasa da iş onun değildir.
    w.raise_dispute(&stranger, &job, MIN_BOND)
        .expect_err("başka kurum")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    // Bond kurumun kendi hesabından çıkar.
    let mixed = Institution {
        key: institution.key.insecure_clone(),
        token_account: stranger.token_account,
    };
    w.raise_dispute(&mixed, &job, MIN_BOND)
        .expect_err("başkasının hesabı")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    // Bond vault'u kanonik PDA'dır.
    let mut ix = w.raise_dispute_ix(&institution, &job, MIN_BOND);
    let at = position(&ix, &bond_address(&job));
    ix.accounts[at].pubkey = Pubkey::new_unique();
    let key = institution.key.insecure_clone();
    w.h.send(&[ix], &[&key])
        .expect_err("sahte bond vault")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
}
