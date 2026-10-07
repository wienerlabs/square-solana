//! BC-39 hesap kısıtı denetiminin kapattığı negatif test boşlukları
//! ([program-constraints.md](../../../docs/security/program-constraints.md)). Kısıtı olan ama reddi
//! denenmemiş hesaplar: kısıt kaldırılır ya da gevşerse bu testler düşer. Her testin başında denetimdeki
//! satır yazılıdır.

mod escrow_world;
mod fiat_world;
mod release_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use escrow_world::*;
use fiat_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::JobStatus;
use square_policy::errors::PolicyError;
use square_program_tests::{anchor_error, programdata_address, token, Harness};
use square_registry::errors::RegistryError;
use square_registry::ScreeningStatus;
use square_verifier::errors::VerifierError;

const LAMPORTS: u64 = 10_000_000_000;

/// Saldırganın upgrade authority olduğu başka bir programın ProgramData'sı.
fn decoy_program_data(h: &mut Harness, authority: &Pubkey) -> Pubkey {
    let decoy = Keypair::new().pubkey();
    h.deploy_upgradeable("square_policy", decoy, *authority);
    programdata_address(&decoy)
}

/// Üç config'in `init_*`'ı: `program.programdata_address() == program_data`. Bu kısıt olmasa programın
/// upgrade authority'si olmayan ilk çağıran, kendi programının ProgramData'sıyla config'i açar; escrow'da
/// arbitrator setini ve bağlı programları, verifier'da `record_release`'i çağırabilecek escrow programını
/// seçerdi.
#[test]
fn config_init_rejects_another_programs_program_data() {
    let mut w = World::deployed(true);
    w.h.deploy_upgradeable("square_verifier", square_verifier::ID, w.admin.pubkey());
    let attacker = w.h.funded(LAMPORTS);
    let program_data = decoy_program_data(&mut w.h, &attacker.pubkey());

    let panel = Panel::new(3, 2);
    let mut ix = w.init_config_ix(
        &attacker.pubkey(),
        w.usdc,
        panel.keys(),
        panel.threshold,
        params(),
    );
    ix.accounts = square_escrow::accounts::InitConfig {
        admin: attacker.pubkey(),
        config: config_address(),
        program: square_escrow::ID,
        program_data,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    w.h.send(&[ix], &[&attacker])
        .expect_err("escrow: başka programın ProgramData'sı")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let mut ix = release_world::init_config_ix(&attacker.pubkey(), Pubkey::new_unique());
    ix.accounts = square_verifier::accounts::InitVerifierConfig {
        admin: attacker.pubkey(),
        config: verifier_config_address(),
        program: square_verifier::ID,
        program_data,
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    w.h.send(&[ix], &[&attacker])
        .expect_err("verifier: başka programın ProgramData'sı")
        .assert_error(anchor_error(VerifierError::Unauthorized));
    assert!(w.h.raw_account(&config_address()).is_none());
    assert!(w.h.raw_account(&verifier_config_address()).is_none());

    // Registry config'i `World::deployed`'da kurulur; ayrı bir ortamda.
    let mut h = Harness::new();
    let admin = h.funded(LAMPORTS);
    h.deploy_upgradeable("square_registry", square_registry::ID, admin.pubkey());
    let attacker = h.funded(LAMPORTS);
    let program_data = decoy_program_data(&mut h, &attacker.pubkey());
    let ix = Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::InitRegistryConfig {
            admin: attacker.pubkey(),
            config: registry_config_address(),
            program: square_registry::ID,
            program_data,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::InitRegistryConfig {
            screener_authority: attacker.pubkey(),
            screening_ttl_secs: SCREENING_TTL,
        }
        .data(),
    };
    h.send(&[ix], &[&attacker])
        .expect_err("registry: başka programın ProgramData'sı")
        .assert_error(anchor_error(RegistryError::Unauthorized));
    assert!(h.raw_account(&registry_config_address()).is_none());
}

/// escrow `sync_agent_wallet`: `has_one = agent_record`. Bu kısıt olmasa başka bir kaydın sahibi, kendi
/// kaydıyla teslim edilmiş bir işin ödemesini kendi cüzdanına çevirirdi.
#[test]
fn sync_agent_wallet_moves_only_jobs_bound_to_the_owners_record() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.delivered_job();
    let other = w.register_agent("other-agent");
    let ix = w.sync_ix(&other.owner.pubkey(), &job, other.record);
    w.h.send(&[ix], &[&other.owner])
        .expect_err("başka kayıt")
        .assert_error(anchor_error(EscrowError::AgentMismatch));
    let ix = w.sync_ix(&other.owner.pubkey(), &job, agent.record);
    w.h.send(&[ix], &[&other.owner])
        .expect_err("kaydın sahibi değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    assert_eq!(w.job(&job).agent_wallet, agent.wallet.pubkey());
}

fn deactivate_ix(authority: &Pubkey, policy: PolicyAccounts) -> Instruction {
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::DeactivatePolicy {
            authority: *authority,
            institution: policy.institution,
            policy: policy.policy,
        }
        .to_account_metas(None),
        data: square_policy::instruction::DeactivatePolicy {}.data(),
    }
}

/// policy `update_policy`, `deactivate_policy`, `set_buyer_root`: politika seeds'i kurumdan türer ve
/// `has_one = institution`. Bir kurumun yetkilisi başka kurumun politikasını değiştiremez.
#[test]
fn policy_instructions_reject_another_institutions_policy() {
    let mut w = World::new(true);
    let (a, b) = (Keypair::new(), Keypair::new());
    let pa = w.policy(&a, POLICY_ID);
    let pb = w.policy(&b, POLICY_ID);
    let before = w.h.raw_account(&pb.policy).expect("Policy").data;

    // A'nın kurumu, B'nin politikası: politika A'nın kurumundan türemez.
    let mixed = PolicyAccounts {
        institution: pa.institution,
        policy: pb.policy,
    };
    for (label, ix) in [
        (
            "update_policy",
            w.update_policy_ix(&a.pubkey(), mixed, [3; 32], 2 * CEILING),
        ),
        ("deactivate_policy", deactivate_ix(&a.pubkey(), mixed)),
        (
            "set_buyer_root",
            w.set_buyer_root_ix(&a.pubkey(), mixed, [4; 32]),
        ),
    ] {
        w.h.send(&[ix], &[&a])
            .expect_err(label)
            .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
    }
    // B'nin kurumu ve politikası: imzacı B'nin yetkilisi değil.
    for (label, ix) in [
        (
            "update_policy",
            w.update_policy_ix(&a.pubkey(), pb, [3; 32], 2 * CEILING),
        ),
        ("deactivate_policy", deactivate_ix(&a.pubkey(), pb)),
        (
            "set_buyer_root",
            w.set_buyer_root_ix(&a.pubkey(), pb, [4; 32]),
        ),
    ] {
        w.h.send(&[ix], &[&a])
            .expect_err(label)
            .assert_error(anchor_error(PolicyError::Unauthorized));
    }
    assert_eq!(w.h.raw_account(&pb.policy).expect("Policy").data, before);
}

/// registry `record_screening`: kayıt `["screening", wallet]`. Screener bir cüzdanın kararını başka
/// cüzdanın kaydına yazamaz.
#[test]
fn record_screening_writes_only_the_screened_wallets_record() {
    let mut w = World::new(true);
    let (wallet, other) = (Keypair::new().pubkey(), Keypair::new().pubkey());
    let mut ix = w.record_screening_ix(&wallet, ScreeningStatus::Flagged);
    ix.accounts = square_registry::accounts::RecordScreening {
        payer: w.h.payer.pubkey(),
        screener_authority: w.screener.pubkey(),
        config: registry_config_address(),
        screening_record: screening_address(&other),
        system_program: anchor_lang::system_program::ID,
    }
    .to_account_metas(None);
    let screener = w.screener.insecure_clone();
    w.h.send(&[ix], &[&screener])
        .expect_err("başka cüzdanın kaydı")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
    assert!(w.h.raw_account(&screening_address(&other)).is_none());
    assert!(w.h.raw_account(&screening_address(&wallet)).is_none());
}

/// escrow `cancel_job`: iadenin hesabı job'un kurumuna ait ve settlement mint'inde. İşin kurumu imzalasa da
/// başkasının ya da başka mint'in hesabına iade olmaz.
#[test]
fn cancel_job_refunds_only_the_institutions_own_settlement_account() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.funded_job();
    let stranger = w.institution(0);
    let rent_payer = w.job(&job).rent_payer;
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        stranger.token_account,
        vault_address(&job),
        rent_payer,
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("başkasının hesabı")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let mint_authority = w.mint_authority.pubkey();
    let other_mint = token::create_usdc_mint(&mut w.h, &mint_authority);
    let other = token::create_ata(&mut w.h, &institution.key.pubkey(), &other_mint);
    let ix = w.cancel_ix(
        &institution.key.pubkey(),
        &job,
        other,
        vault_address(&job),
        rent_payer,
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("başka mint")
        .assert_error(anchor_error(EscrowError::MintMismatch));
    assert_eq!(w.balance(&vault_address(&job)), Some(AMOUNT));
    assert_eq!(w.job(&job).status, JobStatus::Funded);
}

/// escrow `accept_job`: yalnızca `Funded` iş (fiat rayında `Open`) kabul edilir; ikinci kabul yoktur.
#[test]
fn an_accepted_job_is_not_accepted_again() {
    let mut w = World::new(true);
    let (_institution, agent, job) = w.accepted_job();
    let ix = w.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
    w.h.send(&[ix], &[&agent.wallet])
        .expect_err("ikinci kabul")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

/// escrow `buy_claim`: listeleme `["claim", job]` ve `has_one = job`. Bir işin listelemesi başka işin
/// alacağı olarak satılamaz.
#[test]
fn a_listing_is_bought_only_for_its_own_job() {
    let mut w = World::new(true);
    let (_i1, agent, job) = w.delivered_job();
    let (_i2, _a2, other_job) = w.delivered_job();
    let price = w.claim_price(&job);
    let wallet = agent.wallet.insecure_clone();
    w.list_claim(&wallet, &job, price).expect("list_claim");
    let buyer = w.buyer(AMOUNT);
    token::create_ata(&mut w.h, &agent.wallet.pubkey(), &w.usdc.clone());
    let mut ix = w.buy_claim_ix(&buyer, &job, price, &Eligibility::default());
    // Talimatın job'u diğer iş, listeleme ilk işin.
    let job_index = ix
        .accounts
        .iter()
        .position(|meta| meta.pubkey == job)
        .expect("job hesabı");
    ix.accounts[job_index].pubkey = other_job;
    w.h.send(&[ix], &[&buyer.key])
        .expect_err("başka işin listelemesi")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
    assert_eq!(w.balance(&buyer.token_account), Some(AMOUNT));
}

/// escrow `lapse_dispute`: yalnızca `Disputed` iş. Karar son tarihten önce verildiyse (`Resolved`) son
/// tarih geçse de dispute düşmez; karar yürütülür.
#[test]
fn a_resolved_dispute_does_not_lapse_after_its_deadline() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.delivered_job();
    w.raise_dispute(&institution, &job, MIN_BOND)
        .expect("raise_dispute");
    w.decide(
        &job,
        square_escrow::state::DisputeResolution::FavorInstitution,
    );
    w.h.set_time(w.job(&job).dispute.deadline + 1);
    let caller = w.h.funded(LAMPORTS);
    w.lapse(&caller, &job, institution.token_account)
        .expect_err("karar verilmiş dispute")
        .assert_error(anchor_error(EscrowError::NoActiveDispute));
    assert_eq!(w.job(&job).status, JobStatus::Resolved);
}

/// escrow `fund_job`: fiat işin vault'u yoktur ve fonlanamaz (ADR 0024). Bugün ret hesabın
/// yokluğundandır; açık `RailMismatch` denetimi review-bc-39.md'deki bulgudadır.
#[test]
fn a_fiat_job_cannot_be_funded() {
    let mut f = FiatWorld::new();
    f.create().expect("create_fiat_job");
    let institution = f.institution();
    let job = job_address(&institution.pubkey(), &f.r.spec(FIAT));
    let token_account = f.r.institution.token_account;
    let ix = f.r.w.fund_job_ix_with(
        &institution.pubkey(),
        &job,
        token_account,
        vault_address(&job),
    );
    assert!(
        f.r.w.h.send(&[ix], &[&institution]).is_err(),
        "fiat iş fonlandı"
    );
    assert_eq!(f.r.w.job(&job).status, JobStatus::Open);
}

/// escrow `create_fiat_job`: agent'ın screening kaydı `["screening", agent_wallet]` olarak handler'da
/// türetilir. Başka bir cüzdanın temiz kaydı agent'ınki yerine geçmez.
#[test]
fn a_fiat_job_needs_the_agents_own_screening() {
    let mut f = FiatWorld::new();
    let stranger = Keypair::new().pubkey();
    f.r.w.screen(&stranger, ScreeningStatus::Clear);
    f.r.w
        .screen(&f.r.agent.wallet.pubkey(), ScreeningStatus::Flagged);
    let mut ix = f.create_ix(f.r.spec(FIAT), f.r.amount(FIAT), f.r.w.h.now() + 7 * DAY);
    let agent_screening = screening_address(&f.r.agent.wallet.pubkey());
    let index = ix
        .accounts
        .iter()
        .position(|meta| meta.pubkey == agent_screening)
        .expect("agent screening hesabı");
    ix.accounts[index].pubkey = screening_address(&stranger);
    let institution = f.institution();
    f.r.w
        .h
        .send(&[ix], &[&institution])
        .expect_err("başka cüzdanın screening kaydı")
        .assert_error(anchor_error(EscrowError::ScreeningRequired));
}
