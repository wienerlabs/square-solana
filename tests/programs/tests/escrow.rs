//! square_escrow config'i ve `create_job` (BC-22, sözleşme arayüzü): config'i yalnızca yükseltme yetkilisi
//! kurar; iş kayıtlı ve etkin bir registry agent'ına ve isteğe bağlı bir policy'ye bağlanır, rent'i rol
//! imzacısından ayrı bir `payer` öder.

mod escrow_world;

use anchor_lang::error::ErrorCode as AnchorErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use escrow_world::*;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{DisputeInfo, JobStatus};
use square_escrow::{EscrowConfigUpdated, JobCreated};
use square_program_tests::squads::SquadsMultisig;
use square_program_tests::token;
use square_program_tests::{anchor_error, cu, event};
use square_registry::AgentStatus;

#[test]
fn only_the_upgrade_authority_initializes_the_config() {
    let mut w = World::deployed(true);
    let arbitrators = vec![
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];

    let stranger = w.h.funded(1_000_000_000);
    let ix = w.init_config_ix(&stranger.pubkey(), w.usdc, arbitrators.clone(), 2, params());
    w.h.send(&[ix], &[&stranger])
        .expect_err("yükseltme yetkilisi değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let admin = w.admin.insecure_clone();
    let invalid = [
        (
            "challenge alt sınırı 0",
            arbitrators.clone(),
            2,
            EscrowParamsChange::MinChallenge(0),
            EscrowError::InvalidChallengePeriod,
        ),
        (
            "alt sınır üst sınırdan büyük",
            arbitrators.clone(),
            2,
            EscrowParamsChange::MinChallenge(8 * DAY as u64),
            EscrowError::InvalidChallengePeriod,
        ),
        (
            "üst sınır i64'e sığmıyor",
            arbitrators.clone(),
            2,
            EscrowParamsChange::MaxChallenge(u64::MAX),
            EscrowError::InvalidChallengePeriod,
        ),
        (
            "keeper ücreti %100'ü aşıyor",
            arbitrators.clone(),
            2,
            EscrowParamsChange::KeeperFee(10_001),
            EscrowError::InvalidKeeperFee,
        ),
        (
            "M = 1",
            arbitrators.clone(),
            1,
            EscrowParamsChange::None,
            EscrowError::InvalidThreshold,
        ),
        (
            "M > N",
            arbitrators.clone(),
            4,
            EscrowParamsChange::None,
            EscrowError::InvalidThreshold,
        ),
        (
            "tekrar eden arbitrator",
            vec![arbitrators[0], arbitrators[0], arbitrators[1]],
            2,
            EscrowParamsChange::None,
            EscrowError::InvalidArbitratorSet,
        ),
        (
            "boş anahtar",
            vec![arbitrators[0], Pubkey::default()],
            2,
            EscrowParamsChange::None,
            EscrowError::InvalidArbitratorSet,
        ),
        (
            "8 arbitrator",
            (0..8).map(|_| Pubkey::new_unique()).collect(),
            2,
            EscrowParamsChange::None,
            EscrowError::InvalidArbitratorSet,
        ),
    ];
    for (label, set, threshold, change, error) in invalid {
        let ix = w.init_config_ix(
            &admin.pubkey(),
            w.usdc,
            set,
            threshold,
            change.apply(params()),
        );
        w.h.send(&[ix], &[&admin])
            .expect_err(label)
            .assert_error(anchor_error(error));
    }

    let ix = w.init_config_ix(&admin.pubkey(), w.usdc, arbitrators.clone(), 2, params());
    let executed = w.h.send(&[ix], &[&admin]).expect("init_config");
    let config = w.config();
    assert_eq!(config.admin, admin.pubkey());
    assert_eq!(config.settlement_mint, w.usdc);
    assert_eq!(
        (
            config.registry_program,
            config.policy_program,
            config.verifier_program
        ),
        (square_registry::ID, square_policy::ID, verifier::ID)
    );
    assert_eq!(&config.arbitrators[..3], arbitrators.as_slice());
    assert!(config.arbitrators[3..]
        .iter()
        .all(|a| *a == Pubkey::default()));
    assert_eq!((config.arbitrator_count, config.threshold), (3, 2));
    assert_eq!(config.arbitrator_set_version, 0);
    assert_eq!(config.params, params());
    let updated: EscrowConfigUpdated = event(&executed);
    assert_eq!(
        (updated.admin, updated.settlement_mint, updated.params),
        (admin.pubkey(), w.usdc, params())
    );

    // Config tekildir.
    let again = w.init_config_ix(&admin.pubkey(), w.usdc, arbitrators, 2, params());
    assert!(w.h.send(&[again], &[&admin]).is_err());
}

#[test]
fn only_the_admin_updates_the_parameters() {
    let mut w = World::new(true);
    let changed = EscrowParamsChange::KeeperFee(75).apply(params());

    let stranger = w.h.funded(1_000_000_000);
    let ix = w.update_params_ix(&stranger.pubkey(), changed);
    w.h.send(&[ix], &[&stranger])
        .expect_err("admin değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));

    let admin = w.admin.insecure_clone();
    let ix = w.update_params_ix(
        &admin.pubkey(),
        EscrowParamsChange::MinChallenge(0).apply(params()),
    );
    w.h.send(&[ix], &[&admin])
        .expect_err("geçersiz parametre")
        .assert_error(anchor_error(EscrowError::InvalidChallengePeriod));

    let ix = w.update_params_ix(&admin.pubkey(), changed);
    let executed = w.h.send(&[ix], &[&admin]).expect("update_params");
    assert_eq!(w.config().params.keeper_fee_bps, 75);
    assert_eq!(event::<EscrowConfigUpdated>(&executed).params, changed);
}

#[test]
fn create_job_binds_the_agent_and_a_separate_payer_pays_the_rent() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");
    // Kurumun lamport'u yok: rent ve ücret `payer`'dan (sponsorlu işlem).
    assert_eq!(w.h.lamports(&institution.key.pubkey()), 0);
    let deadline = w.h.now() + 7 * DAY;

    let ix = w.create_job_ix(
        &institution.key.pubkey(),
        agent.record,
        None,
        SPEC,
        AMOUNT,
        deadline,
        CHALLENGE,
        w.usdc,
    );
    let executed = w.h.send(&[ix], &[&institution.key]).expect("create_job");
    cu::within("escrow.create_job", &executed, 40_000);

    let job_key = job_address(&institution.key.pubkey(), &SPEC);
    let job = w.job(&job_key);
    assert_eq!(job.institution, institution.key.pubkey());
    assert_eq!(job.agent_record, agent.record);
    assert_eq!(job.agent_wallet, agent.wallet.pubkey());
    assert_eq!(job.mint, w.usdc);
    assert_eq!(job.rent_payer, w.h.payer.pubkey());
    assert_eq!((job.amount, job.spec_hash), (AMOUNT, SPEC));
    assert_eq!(job.status, JobStatus::Open);
    assert_eq!((job.created_at, job.funded_at), (NOW, 0));
    assert_eq!((job.deadline, job.challenge_period), (deadline, CHALLENGE));
    assert_eq!(job.policy, None);
    assert_eq!(job.policy_commitment, [0; 32]);
    assert_eq!((job.policy_daily_ceiling, job.policy_version), (0, 0));
    assert_eq!(job.dispute, DisputeInfo::default());
    assert_eq!(job.delivery_uri, "");
    assert_eq!(w.h.lamports(&institution.key.pubkey()), 0);

    // Vault: job'un PDA'sı, token yetkilisi job, bakiye 0 (fonlar fund_job'da gelir).
    let vault = vault_address(&job_key);
    assert_eq!(w.balance(&vault), Some(0));
    let vault_account = token::token_account(&w.h, &vault).expect("vault");
    assert_eq!((vault_account.owner, vault_account.mint), (job_key, w.usdc));
    assert_eq!(w.balance(&institution.token_account), Some(AMOUNT));

    let created: JobCreated = event(&executed);
    assert_eq!(created.job, job_key);
    assert_eq!(
        (
            created.institution,
            created.agent_record,
            created.agent_wallet
        ),
        (
            institution.key.pubkey(),
            agent.record,
            agent.wallet.pubkey()
        )
    );
    assert_eq!((created.policy, created.policy_version), (None, 0));
    assert_eq!(
        (created.mint, created.amount, created.spec_hash),
        (w.usdc, AMOUNT, SPEC)
    );
    assert_eq!(
        (created.deadline, created.challenge_period),
        (deadline, CHALLENGE)
    );
}

#[test]
fn a_policy_job_snapshots_the_policy() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");
    let policy = w.policy(&institution.key, [7; 32]);

    let ix = w.default_create_ix(&institution.key.pubkey(), &agent, Some(policy));
    let executed = w.h.send(&[ix], &[&institution.key]).expect("create_job");
    cu::within("escrow.create_job (policy)", &executed, 50_000);
    let job = w.job(&job_address(&institution.key.pubkey(), &SPEC));
    assert_eq!(job.policy, Some(policy.policy));
    assert_eq!(job.policy_commitment, COMMITMENT);
    assert_eq!((job.policy_daily_ceiling, job.policy_version), (CEILING, 1));
    let created: JobCreated = event(&executed);
    assert_eq!(
        (created.policy, created.policy_version),
        (Some(policy.policy), 1)
    );
}

#[test]
fn create_job_rejects_invalid_terms_and_a_foreign_mint() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");
    let now = w.h.now();
    let other_mint = token::create_usdc_mint(&mut w.h, &w.mint_authority.pubkey());

    let cases = [
        (
            "tutar 0",
            0,
            now + DAY,
            CHALLENGE,
            w.usdc,
            EscrowError::InvalidAmount,
        ),
        (
            "geçmiş deadline",
            AMOUNT,
            now,
            CHALLENGE,
            w.usdc,
            EscrowError::DeadlineExpired,
        ),
        (
            "challenge alt sınırın altında",
            AMOUNT,
            now + DAY,
            HOUR as u64 - 1,
            w.usdc,
            EscrowError::InvalidChallengePeriod,
        ),
        (
            "challenge üst sınırın üstünde",
            AMOUNT,
            now + DAY,
            7 * DAY as u64 + 1,
            w.usdc,
            EscrowError::InvalidChallengePeriod,
        ),
        (
            "settlement mint'i değil",
            AMOUNT,
            now + DAY,
            CHALLENGE,
            other_mint,
            EscrowError::MintMismatch,
        ),
    ];
    for (label, amount, deadline, period, mint, error) in cases {
        let ix = w.create_job_ix(
            &institution.key.pubkey(),
            agent.record,
            None,
            SPEC,
            amount,
            deadline,
            period,
            mint,
        );
        w.h.send(&[ix], &[&institution.key])
            .expect_err(label)
            .assert_error(anchor_error(error));
    }
}

#[test]
fn create_job_requires_a_registered_active_agent() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");

    // Registry'ye ait olmayan hesaplar: kurumun token hesabı ve square_policy'nin bir hesabı.
    let policy = w.policy(&institution.key, [7; 32]);
    for (label, account) in [
        ("token hesabı", institution.token_account),
        ("policy hesabı", policy.policy),
        ("var olmayan hesap", Pubkey::new_unique()),
    ] {
        let ix = w.create_job_ix(
            &institution.key.pubkey(),
            account,
            None,
            SPEC,
            AMOUNT,
            w.h.now() + DAY,
            CHALLENGE,
            w.usdc,
        );
        w.h.send(&[ix], &[&institution.key])
            .expect_err(label)
            .assert_error(anchor_error(EscrowError::AgentNotRegistered));
    }

    w.set_agent_status(&agent, AgentStatus::Inactive)
        .expect("Inactive");
    let ix = w.default_create_ix(&institution.key.pubkey(), &agent, None);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("Inactive agent")
        .assert_error(anchor_error(EscrowError::AgentInactive));

    w.deregister_agent(&agent).expect("deregister_agent");
    let ix = w.default_create_ix(&institution.key.pubkey(), &agent, None);
    w.h.send(&[ix], &[&institution.key])
        .expect_err("Deregistered agent")
        .assert_error(anchor_error(EscrowError::AgentInactive));
}

#[test]
fn create_job_checks_the_policy_and_its_institution() {
    let mut w = World::new(true);
    let institution = w.institution(AMOUNT);
    let agent = w.register_agent("research-agent");
    let own = w.policy(&institution.key, [7; 32]);
    let other_owner = w.h.funded(1_000_000_000);
    let other = w.policy(&other_owner, [7; 32]);
    let create = |w: &World, policy: Option<PolicyAccounts>| {
        w.default_create_ix(&institution.key.pubkey(), &agent, policy)
    };

    // Policy ile kurumu birlikte gelir.
    let mut ix = create(&w, Some(own));
    ix.accounts[5].pubkey = square_escrow::ID; // Anchor'ın "yok" işareti: policy_institution
    w.h.send(&[ix], &[&institution.key])
        .expect_err("kurumsuz policy")
        .assert_error(anchor_error(EscrowError::PolicyMismatch));

    let cases = [
        (
            "başka kurumun politikası",
            PolicyAccounts {
                policy: other.policy,
                institution: other.institution,
            },
            EscrowError::Unauthorized,
        ),
        (
            "politika ile kurumu uyuşmuyor",
            PolicyAccounts {
                policy: other.policy,
                institution: own.institution,
            },
            EscrowError::PolicyMismatch,
        ),
        (
            "policy programına ait değil",
            PolicyAccounts {
                policy: agent.record,
                institution: own.institution,
            },
            EscrowError::LinkedProgramMismatch,
        ),
        (
            "kurum hesabı policy programına ait değil",
            PolicyAccounts {
                policy: own.policy,
                institution: agent.record,
            },
            EscrowError::LinkedProgramMismatch,
        ),
    ];
    for (label, policy, error) in cases {
        let ix = create(&w, Some(policy));
        w.h.send(&[ix], &[&institution.key])
            .expect_err(label)
            .assert_error(anchor_error(error));
    }

    let deactivate = anchor_lang::solana_program::instruction::Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::DeactivatePolicy {
            authority: institution.key.pubkey(),
            institution: own.institution,
            policy: own.policy,
        }
        .to_account_metas(None),
        data: square_policy::instruction::DeactivatePolicy {}.data(),
    };
    w.h.send(&[deactivate], &[&institution.key])
        .expect("deactivate_policy");
    let ix = create(&w, Some(own));
    w.h.send(&[ix], &[&institution.key])
        .expect_err("kapalı politika")
        .assert_error(anchor_error(EscrowError::PolicyInactive));
}

#[test]
fn a_squads_vault_institution_opens_policy_jobs_after_binding() {
    let mut w = World::new(false);
    let owner = w.h.funded(1_000_000_000);
    let agent = w.register_agent("research-agent");
    let policy = w.policy(&owner, [7; 32]);
    let multisig = SquadsMultisig::create(&mut w.h);
    let bind = anchor_lang::solana_program::instruction::Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::SetInstitutionMultisig {
            authority: owner.pubkey(),
            institution: policy.institution,
            squads_multisig: multisig.address,
        }
        .to_account_metas(None),
        data: square_policy::instruction::SetInstitutionMultisig {
            multisig: multisig.address,
            vault_index: 0,
        }
        .data(),
    };
    w.h.send(&[bind], &[&owner])
        .expect("set_institution_multisig");
    let vault = multisig.vault(0);

    // Multisig bağlandıktan sonra kurum anahtarı policy'li iş açamaz; vault açar.
    let ix = w.default_create_ix(&owner.pubkey(), &agent, Some(policy));
    w.h.send(&[ix], &[&owner])
        .expect_err("kurum anahtarı")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    let ix = w.default_create_ix(&vault, &agent, Some(policy));
    w.h.send_as(&[ix], &[], &[vault]).expect("vault create_job");
    let job = w.job(&job_address(&vault, &SPEC));
    assert_eq!((job.institution, job.policy), (vault, Some(policy.policy)));
}

#[test]
fn the_vault_is_pinned_to_the_job_and_the_same_spec_opens_once() {
    let mut w = World::new(true);
    let (institution, agent, job) = w.open_job(false);

    let again = w.default_create_ix(&institution.key.pubkey(), &agent, None);
    assert!(
        w.h.send(&[again], &[&institution.key]).is_err(),
        "aynı spec iki kez"
    );

    // Sahte vault: job'a ait ama kanonik PDA olmayan bir token hesabı (Covenant guard'ı).
    let decoy = token::create_ata(&mut w.h, &job, &w.usdc);
    let ix = w.fund_job_ix_with(
        &institution.key.pubkey(),
        &job,
        institution.token_account,
        decoy,
    );
    w.h.send(&[ix], &[&institution.key])
        .expect_err("sahte vault")
        .assert_error(anchor_error(AnchorErrorCode::ConstraintSeeds));
}

/// `params()`'tan tek alanı değişmiş parametreler.
enum EscrowParamsChange {
    None,
    MinChallenge(u64),
    MaxChallenge(u64),
    KeeperFee(u16),
}

impl EscrowParamsChange {
    fn apply(self, base: square_escrow::EscrowParams) -> square_escrow::EscrowParams {
        match self {
            Self::None => base,
            Self::MinChallenge(v) => square_escrow::EscrowParams {
                min_challenge_period: v,
                ..base
            },
            Self::MaxChallenge(v) => square_escrow::EscrowParams {
                max_challenge_period: v,
                ..base
            },
            Self::KeeperFee(v) => square_escrow::EscrowParams {
                keeper_fee_bps: v,
                ..base
            },
        }
    }
}
