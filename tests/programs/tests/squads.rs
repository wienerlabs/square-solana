//! Squads smart account ve sponsorlu ücret (BC-35): akışın sekiz adımı, rol imzacıları Squads v4 vault
//! PDA'ları olarak geçer. Kurum vault'u politikayı, alıcı listesini ve işi yazar, ispatı bağlar; agent
//! vault'u işi kabul edip teslim eder ve alacağı listeler; alıcı vault'u alacağı alır ve payee olur. Her
//! işlemin ücretini ve her hesabın rent'ini rolü olmayan bir sponsor (harness'in ödeyicisi) öder; vault'lar
//! hiç SOL tutmaz. Release ispatı gerçek bir Groth16 ispatıdır: vault adresleri etiketlerden türetilir ve
//! ispat bu adreslere göre üretilmiştir (`fixtures/squads-proofs.json`, `program-proofs.mjs --squads`).
//!
//! Squads programının kendisi ortamda yoktur: multisig hesabı Squads'a ait ve `Multisig` discriminator'lı
//! yazılır, vault imzası imza doğrulamasız ortamda verilir (`Harness::send_as`). Programların Squads'tan
//! beklediği yalnızca budur (`square_common::squads`).

mod escrow_world;
mod release_world;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use escrow_world::*;
use release_world::{
    array, init_config_ix, keypair, operator_state_address, proof, release_proof_address, sha256,
    CU_LIMIT, DELIVERY_URI,
};
use serde_json::Value;
use solana_signer::Signer;
use square_escrow::errors::EscrowError;
use square_escrow::state::{ClaimStatus, JobStatus};
use square_policy::errors::PolicyError;
use square_program_tests::squads::SquadsMultisig;
use square_program_tests::{anchor_error, compute_unit_limit, token, Outcome};
use square_registry::ScreeningStatus;

const FIXTURE: &str = include_str!("fixtures/squads-proofs.json");
const AGENT_ID: &str = "squads-agent";
const LAMPORTS: u64 = 1_000_000_000;
const BUYER_SALT: [u8; 32] = [0x3b; 32];
/// Her imza 5 000 lamport (LiteSVM varsayılanı).
const SIGNATURE_FEE: u64 = 5_000;

struct Vaults {
    institution: Pubkey,
    agent: Pubkey,
    buyer: Pubkey,
}

/// Programlar, escrow ve verifier config'i kurulu; üç multisig fikstürün adreslerinde, saat ispatların
/// anından iki saat önce.
fn world() -> (World, Value, Vaults) {
    let fx: Value = serde_json::from_str(FIXTURE).expect("squads-proofs.json");
    let mint = keypair(&fx, "settlementMint");
    let mut w = World::configured(World::deployed_with_mint(false, &mint));
    w.h.deploy_upgradeable("square_verifier", square_verifier::ID, w.admin.pubkey());
    let admin = w.admin.insecure_clone();
    w.h.send(
        &[init_config_ix(&admin.pubkey(), Pubkey::new_unique())],
        &[&admin],
    )
    .expect("init_verifier_config");
    w.h.set_time(fx["timestamp"].as_i64().unwrap() - 2 * HOUR);
    let index = fx["vault_index"].as_u64().unwrap() as u8;
    let mut vault = |label: &str| {
        let multisig = SquadsMultisig::at(&mut w.h, keypair(&fx, label).pubkey());
        multisig.vault(index)
    };
    let vaults = Vaults {
        institution: vault("institutionMultisig"),
        agent: vault("agentMultisig"),
        buyer: vault("buyerMultisig"),
    };
    (w, fx, vaults)
}

/// İşlemi vault imzasıyla gönderir; ücreti sponsor öder.
fn as_vault(w: &mut World, ixs: &[Instruction], vault: Pubkey) -> Outcome {
    w.h.send_as(ixs, &[], &[vault])
}

fn init_institution_ix(w: &World, authority: &Pubkey) -> Instruction {
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::InitInstitution {
            payer: w.h.payer.pubkey(),
            authority: *authority,
            institution: institution_address(authority),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_policy::instruction::InitInstitution {
            name: "Squads institution".to_string(),
        }
        .data(),
    }
}

fn set_buyer_root_ix(
    authority: &Pubkey,
    policy: PolicyAccounts,
    buyer_root: [u8; 32],
) -> Instruction {
    Instruction {
        program_id: square_policy::ID,
        accounts: square_policy::accounts::SetBuyerRoot {
            authority: *authority,
            institution: policy.institution,
            policy: policy.policy,
        }
        .to_account_metas(None),
        data: square_policy::instruction::SetBuyerRoot { buyer_root }.data(),
    }
}

fn register_agent_ix(w: &World, owner: &Pubkey, wallet: Pubkey) -> Instruction {
    Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::RegisterAgent {
            payer: w.h.payer.pubkey(),
            owner: *owner,
            agent_record: agent_record_address(owner, AGENT_ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::RegisterAgent {
            agent_id: AGENT_ID.to_string(),
            agent_card_uri: String::new(),
            agent_card_hash: [0; 32],
            wallet,
        }
        .data(),
    }
}

fn buy_claim_ix(
    w: &World,
    buyer: &Pubkey,
    buyer_token_account: Pubkey,
    job: &Pubkey,
    price: u64,
    eligibility: &Eligibility,
) -> Instruction {
    let listing = w.claim(job);
    Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::BuyClaim {
            buyer: *buyer,
            config: config_address(),
            job: *job,
            claim_listing: claim_address(job),
            policy: w.job(job).policy,
            buyer_screening: screening_address(buyer),
            buyer_token_account,
            seller_token_account: token::ata_address(&listing.seller, &w.usdc),
            mint: w.usdc,
            token_program: token::TOKEN_PROGRAM_ID,
        }
        .to_account_metas(None),
        data: square_escrow::instruction::BuyClaim {
            price,
            leaf_salt: eligibility.leaf_salt,
            merkle_proof: eligibility.proof.clone(),
        }
        .data(),
    }
}

fn bind_ix(
    w: &World,
    authority: &Pubkey,
    policy: PolicyAccounts,
    job: &Pubkey,
    fx: &Value,
) -> Instruction {
    let p = proof(fx, "buyer_vault_payee");
    Instruction {
        program_id: square_verifier::ID,
        accounts: square_verifier::accounts::SetComplianceProof {
            payer: w.h.payer.pubkey(),
            authority: *authority,
            config: verifier_config_address(),
            institution: policy.institution,
            policy: policy.policy,
            job: *job,
            claim_listing: claim_address(job),
            operator_state: operator_state_address(&policy.institution),
            release_proof: release_proof_address(job),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_verifier::instruction::SetComplianceProof {
            proof_a: p.proof_a,
            proof_b: p.proof_b,
            proof_c: p.proof_c,
            refusal_code: p.refusal_code,
            net_amount: p.net_amount,
            proof_timestamp: p.timestamp,
        }
        .data(),
    }
}

/// Kabul öncesi ön-ispat (ADR 0028), kurum vault'unun imzasıyla: payee agent vault'u, net tutarın tamamı.
fn preflight_ix(
    w: &World,
    authority: &Pubkey,
    policy: PolicyAccounts,
    job: &Pubkey,
    fx: &Value,
) -> Instruction {
    let p = proof(fx, "preflight");
    Instruction {
        program_id: square_verifier::ID,
        accounts: square_verifier::accounts::SetPreflightProof {
            payer: w.h.payer.pubkey(),
            authority: *authority,
            config: verifier_config_address(),
            institution: policy.institution,
            policy: policy.policy,
            job: *job,
            preflight_proof: preflight_address(job),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_verifier::instruction::SetPreflightProof {
            proof_a: p.proof_a,
            proof_b: p.proof_b,
            proof_c: p.proof_c,
            refusal_code: p.refusal_code,
            proof_timestamp: p.timestamp,
        }
        .data(),
    }
}

#[test]
fn the_eight_steps_pass_with_squads_vaults_and_a_sponsor_paying() {
    let (mut w, fx, v) = world();
    let sponsor = w.h.payer.pubkey();
    let amount: u64 = fx["amount"].as_str().unwrap().parse().unwrap();
    let spec_hash = sha256(fx["spec"].as_str().unwrap());
    let policy_id = sha256(fx["policy"]["policy_id"].as_str().unwrap());
    let commitment: [u8; 32] = array(fx["policy"]["commitment"].as_str().unwrap());
    let ceiling: u64 = fx["policy"]["daily_ceiling"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    // 1. Kurum vault'u: kurum hesabı, politika commitment'ı ve onaylı alıcı listesi.
    let init = init_institution_ix(&w, &v.institution);
    as_vault(&mut w, &[init], v.institution).expect("init_institution");
    let institution = institution_address(&v.institution);
    let policy = PolicyAccounts {
        policy: policy_address(&institution, &policy_id),
        institution,
    };
    let set = w.set_policy_ix(&v.institution, institution, policy_id, commitment, ceiling);
    as_vault(&mut w, &[set], v.institution).expect("set_policy");
    let buyers = BuyerList::new(vec![(v.buyer, BUYER_SALT)]);
    as_vault(
        &mut w,
        &[set_buyer_root_ix(&v.institution, policy, buyers.root())],
        v.institution,
    )
    .expect("set_buyer_root");

    // 2. Agent vault'u kaydın sahibi ve agent cüzdanı.
    let register = register_agent_ix(&w, &v.agent, v.agent);
    as_vault(&mut w, &[register], v.agent).expect("register_agent");
    let record = agent_record_address(&v.agent, AGENT_ID);

    // 3. Screening (screener servisi), iş açma ve fonlama: kurumun USDC'si vault'unun ATA'sında.
    for wallet in [v.institution, v.agent, v.buyer] {
        w.screen(&wallet, ScreeningStatus::Clear);
    }
    let usdc = w.usdc;
    let institution_ata = token::create_ata(&mut w.h, &v.institution, &usdc);
    let mint_authority = w.mint_authority.insecure_clone();
    token::mint_to(&mut w.h, &usdc, &mint_authority, &institution_ata, amount);
    let create = w.create_job_ix(
        &v.institution,
        record,
        Some(policy),
        spec_hash,
        amount,
        w.h.now() + 7 * DAY,
        HOUR as u64,
        usdc,
    );
    as_vault(&mut w, &[create], v.institution).expect("create_job");
    let job = job_address(&v.institution, &spec_hash);
    let fund = w.fund_job_ix_with(&v.institution, &job, institution_ata, vault_address(&job));
    as_vault(&mut w, &[fund], v.institution).expect("fund_job");
    assert_eq!(w.balance(&vault_address(&job)), Some(amount));

    // 4. Kurum vault'u kabul öncesi ön-ispatı bağlar (ADR 0028); agent vault'u kabul eder ve teslim eder.
    let preflight = preflight_ix(&w, &v.institution, policy, &job, &fx);
    as_vault(
        &mut w,
        &[compute_unit_limit(CU_LIMIT), preflight],
        v.institution,
    )
    .expect("set_preflight_proof");
    let accept = w.accept_ix(&v.agent, &job, record, spec_hash);
    as_vault(&mut w, &[accept], v.agent).expect("accept_job");
    let submit = w.submit_ix(&v.agent, &job, record, DELIVERY_URI);
    as_vault(&mut w, &[submit], v.agent).expect("submit_work");

    // 5. Alacak: agent vault'u listeler, alıcı vault'u kurumun listesindeki kanıtıyla alır.
    let price = w.claim_price(&job);
    let list = w.list_claim_ix(&v.agent, &job, price);
    as_vault(&mut w, &[list], v.agent).expect("list_claim");
    let agent_ata = token::create_ata(&mut w.h, &v.agent, &usdc);
    let buyer_ata = token::create_ata(&mut w.h, &v.buyer, &usdc);
    token::mint_to(&mut w.h, &usdc, &mint_authority, &buyer_ata, price);
    let buy = buy_claim_ix(&w, &v.buyer, buyer_ata, &job, price, &buyers.eligibility(0));
    as_vault(&mut w, &[buy], v.buyer).expect("buy_claim");
    assert_eq!(w.claim(&job).status, ClaimStatus::Bought);
    assert_eq!(w.balance(&agent_ata), Some(price));

    // 6–8. Pencere kapanır; kurum vault'u ispatı bağlar; herhangi bir keeper finalize eder, net alıcı vault'una.
    w.h.set_time(fx["timestamp"].as_i64().unwrap());
    let bind = bind_ix(&w, &v.institution, policy, &job, &fx);
    as_vault(&mut w, &[compute_unit_limit(CU_LIMIT), bind], v.institution)
        .expect("set_compliance_proof");
    let keeper = w.h.funded(LAMPORTS);
    let keeper_ata = token::create_ata(&mut w.h, &keeper.pubkey(), &usdc);
    let settlement = Settlement {
        payee: v.buyer,
        payee_token_account: buyer_ata,
        institution_token_account: institution_ata,
        keeper_token_account: keeper_ata,
    };
    let gate = GateAccounts {
        release_proof: release_proof_address(&job),
        operator_state: operator_state_address(&institution),
    };
    assert_eq!(w.job(&job).rent_payer, sponsor, "rent'i sponsor ödedi");
    let vault_rent = w.h.lamports(&vault_address(&job));
    let sponsor_before = w.h.lamports(&sponsor);
    let finalize = w.finalize_ix(&keeper.pubkey(), &job, settlement, Some(gate));
    w.h.send(&[compute_unit_limit(CU_LIMIT), finalize], &[&keeper])
        .expect("finalize_payment");

    let net = proof(&fx, "buyer_vault_payee").net_amount;
    assert_eq!(w.job(&job).status, JobStatus::Released);
    assert_eq!(w.balance(&buyer_ata), Some(net), "net alıcı vault'una");
    assert_eq!(w.balance(&keeper_ata), Some(amount - net), "keeper ücreti");
    assert_eq!(w.balance(&institution_ata), Some(0));
    assert_eq!(w.balance(&vault_address(&job)), None, "vault kapandı");
    // Vault'un rent'i sponsora döndü; sponsor bu işlemin iki imzasının ücretini de ödedi.
    assert_eq!(
        w.h.lamports(&sponsor),
        sponsor_before + vault_rent - 2 * SIGNATURE_FEE
    );
    // Vault'lar hiçbir adımda ücret ya da rent ödemedi.
    for vault in [v.institution, v.agent, v.buyer] {
        assert_eq!(w.h.lamports(&vault), 0, "vault SOL harcamadı");
    }
}

#[test]
fn the_sponsor_pays_but_holds_no_role() {
    let (mut w, fx, v) = world();
    let sponsor = w.h.payer.insecure_clone();
    let amount: u64 = fx["amount"].as_str().unwrap().parse().unwrap();
    let spec_hash = sha256(fx["spec"].as_str().unwrap());
    let policy_id = sha256(fx["policy"]["policy_id"].as_str().unwrap());
    // Fikstürün politikası: kabul öncesi ön-ispat (ADR 0028) onun commitment'ına karşı doğrulanır.
    let commitment: [u8; 32] = array(fx["policy"]["commitment"].as_str().unwrap());
    let ceiling: u64 = fx["policy"]["daily_ceiling"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();

    let init = init_institution_ix(&w, &v.institution);
    as_vault(&mut w, &[init], v.institution).expect("init_institution");
    let institution = institution_address(&v.institution);
    let set = w.set_policy_ix(&v.institution, institution, policy_id, commitment, ceiling);
    as_vault(&mut w, &[set], v.institution).expect("set_policy");
    let policy = PolicyAccounts {
        policy: policy_address(&institution, &policy_id),
        institution,
    };
    // Kurum vault'unun politikasını sponsor yazamaz.
    let foreign = w.set_policy_ix(&sponsor.pubkey(), institution, [9; 32], [0x2c; 32], CEILING);
    w.h.send(&[foreign], &[&sponsor])
        .expect_err("sponsor kurumun yetkilisi değil")
        .assert_error(anchor_error(PolicyError::Unauthorized));

    let register = register_agent_ix(&w, &v.agent, v.agent);
    as_vault(&mut w, &[register], v.agent).expect("register_agent");
    let record = agent_record_address(&v.agent, AGENT_ID);
    for wallet in [v.institution, v.agent] {
        w.screen(&wallet, ScreeningStatus::Clear);
    }
    let usdc = w.usdc;
    let institution_ata = token::create_ata(&mut w.h, &v.institution, &usdc);
    let mint_authority = w.mint_authority.insecure_clone();
    token::mint_to(&mut w.h, &usdc, &mint_authority, &institution_ata, amount);
    let create = w.create_job_ix(
        &v.institution,
        record,
        Some(policy),
        spec_hash,
        amount,
        w.h.now() + 7 * DAY,
        HOUR as u64,
        usdc,
    );
    as_vault(&mut w, &[create], v.institution).expect("create_job");
    let job = job_address(&v.institution, &spec_hash);

    // İşi sponsor fonlayamaz, kabul edemez; kurum vault'unun imzası olmadan fonlama da olmaz.
    let fund_by_sponsor = w.fund_job_ix_with(
        &sponsor.pubkey(),
        &job,
        institution_ata,
        vault_address(&job),
    );
    w.h.send(&[fund_by_sponsor], &[&sponsor])
        .expect_err("sponsor kurum değil")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    let fund = w.fund_job_ix_with(&v.institution, &job, institution_ata, vault_address(&job));
    as_vault(&mut w, &[fund], v.institution).expect("fund_job");
    let accept_by_sponsor = w.accept_ix(&sponsor.pubkey(), &job, record, spec_hash);
    w.h.send(&[accept_by_sponsor], &[&sponsor])
        .expect_err("sponsor agent cüzdanı değil")
        .assert_error(anchor_error(EscrowError::AgentMismatch));

    // Rent'in dönüşü kayıtlı ödeyiciye bağlı: kapanışta rent başka bir hesaba yönlendirilemez.
    let preflight = preflight_ix(&w, &v.institution, policy, &job, &fx);
    as_vault(
        &mut w,
        &[compute_unit_limit(CU_LIMIT), preflight],
        v.institution,
    )
    .expect("set_preflight_proof");
    let accept = w.accept_ix(&v.agent, &job, record, spec_hash);
    as_vault(&mut w, &[accept], v.agent).expect("accept_job");
    let submit = w.submit_ix(&v.agent, &job, record, DELIVERY_URI);
    as_vault(&mut w, &[submit], v.agent).expect("submit_work");
    w.h.set_time(fx["timestamp"].as_i64().unwrap());
    let keeper = w.h.funded(LAMPORTS);
    let keeper_ata = token::create_ata(&mut w.h, &keeper.pubkey(), &usdc);
    let agent_ata = token::create_ata(&mut w.h, &v.agent, &usdc);
    let settlement = Settlement {
        payee: v.agent,
        payee_token_account: agent_ata,
        institution_token_account: institution_ata,
        keeper_token_account: keeper_ata,
    };
    let mut finalize = w.finalize_ix(&keeper.pubkey(), &job, settlement, None);
    let rent_payer = finalize
        .accounts
        .iter_mut()
        .rev()
        .find(|meta| meta.pubkey == sponsor.pubkey())
        .expect("rent_payer hesabı");
    rent_payer.pubkey = keeper.pubkey();
    w.h.send(&[finalize], &[&keeper])
        .expect_err("rent başka hesaba")
        .assert_error(anchor_error(EscrowError::Unauthorized));
    assert_eq!(w.job(&job).status, JobStatus::Delivered);
    // Programların hiçbiri vault'tan SOL çekmedi; ücret ve rent sponsordan.
    for vault in [v.institution, v.agent] {
        assert_eq!(w.h.lamports(&vault), 0);
    }
}

/// Config talimatlarının rent'ini yükseltme yetkilisi öder; Squads'lı deploy'da (BC-09) bu bir vault'tur.
/// Vault SOL tutar ve config'leri kendi imzasıyla kurar; anahtarlı bir admin gerekmez.
#[test]
fn a_squads_vault_upgrade_authority_initializes_the_configs() {
    let mut h = square_program_tests::Harness::without_sigverify();
    let multisig = SquadsMultisig::create(&mut h);
    let admin = multisig.vault(0);
    for (name, id) in [
        ("square_escrow", square_escrow::ID),
        ("square_registry", square_registry::ID),
        ("square_verifier", square_verifier::ID),
    ] {
        h.deploy_upgradeable(name, id, admin);
    }
    h.deploy("square_policy", square_policy::ID);
    h.svm.airdrop(&admin, LAMPORTS).expect("vault'a SOL");
    let mint_authority = solana_keypair::Keypair::new();
    let usdc = token::create_usdc_mint(&mut h, &mint_authority.pubkey());

    let registry_config = Pubkey::find_program_address(
        &[square_common::seeds::REGISTRY_CONFIG_SEED],
        &square_registry::ID,
    )
    .0;
    let registry = Instruction {
        program_id: square_registry::ID,
        accounts: square_registry::accounts::InitRegistryConfig {
            admin,
            config: registry_config,
            program: square_registry::ID,
            program_data: square_program_tests::programdata_address(&square_registry::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_registry::instruction::InitRegistryConfig {
            screener_authority: Pubkey::new_unique(),
            screening_ttl_secs: SCREENING_TTL,
        }
        .data(),
    };
    let escrow = Instruction {
        program_id: square_escrow::ID,
        accounts: square_escrow::accounts::InitConfig {
            admin,
            config: config_address(),
            program: square_escrow::ID,
            program_data: square_program_tests::programdata_address(&square_escrow::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_escrow::instruction::InitConfig {
            settlement_mint: usdc,
            arbitrators: vec![Pubkey::new_unique(), Pubkey::new_unique()],
            threshold: 2,
            params: params(),
            linked: linked(),
        }
        .data(),
    };
    let verifier = init_config_ix(&admin, Pubkey::new_unique());
    let before = h.lamports(&admin);
    h.send_as(&[registry, escrow, verifier], &[], &[admin])
        .expect("config'ler vault imzasıyla");

    let config: square_escrow::state::EscrowConfig =
        h.account(&config_address()).expect("EscrowConfig");
    assert_eq!(config.admin, admin);
    assert_eq!(config.settlement_mint, usdc);
    // Üç config hesabının rent'i vault'tan; işlem ücreti harness'in ödeyicisinden.
    let rent: u64 = [registry_config, config_address(), verifier_config_address()]
        .iter()
        .map(|address| h.lamports(address))
        .sum();
    assert_eq!(h.lamports(&admin), before - rent);
}
