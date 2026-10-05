//! square_verifier (BC-21, sözleşme arayüzü): release ispatının job'a bağlanması ve günlük sayaç.
//!
//! İspatlar gerçek Groth16 ispatlarıdır (tests/fixtures/release-proofs.json,
//! circuits/payment-compliance/scripts/program-proofs.mjs). Kurum ve agent cüzdanı, settlement mint'i
//! ve politika devrenin test dünyasıyla aynı etiketlerden türetilir; job'lar escrow'un kendi
//! instruction'larıyla teslim edilir. Böylece programın hesaplardan kurduğu sinyaller ispatın
//! sinyalleriyle yalnızca her şey doğruysa eşleşir.

mod escrow_world;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountSerialize, InstructionData, ToAccountMetas};
use escrow_world::*;
use serde_json::Value;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::contract::square_escrow_contract::accounts::ClaimListing;
use square_common::contract::square_escrow_contract::types::ClaimStatus;
use square_common::contract::square_verifier_contract::accounts as contract;
use square_common::release::{check_fresh, ReleaseFacts, Staleness};
use square_common::seeds::{
    CLAIM_SEED, ESCROW_AUTHORITY_SEED, OPERATOR_STATE_SEED, RELEASE_PROOF_SEED,
    VERIFIER_CONFIG_SEED,
};
use square_common::time::day_start;
use square_program_tests::{
    anchor_error, compute_unit_limit, cu, event, programdata_address, Outcome,
};
use square_registry::ScreeningStatus;
use square_verifier::errors::VerifierError;
use square_verifier::state::{OperatorState, ReleaseProof, VerifierConfig};
use square_verifier::{
    ComplianceProofSet, ReleaseRecorded, ReleaseVerdict, VerifierConfigUpdated,
    CLOCK_TOLERANCE_SECS, RELEASE_VK_VERSION,
};

const FIXTURE: &str = include_str!("fixtures/release-proofs.json");
const DELIVERY_URI: &str = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
/// Groth16 doğrulaması talimat başına varsayılan 200 000 CU'yu aşar.
const CU_LIMIT: u32 = 1_400_000;

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("release-proofs.json")
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

fn array<const N: usize>(hex: &str) -> [u8; N] {
    bytes(hex).try_into().expect("uzunluk")
}

fn sha256(text: &str) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[text.as_bytes()]).to_bytes()
}

/// Devrenin test anahtarları: tohum `sha256(seed_prefix ‖ etiket)` (release-input.mjs `keyFromLabel`).
fn keypair(fx: &Value, key: &str) -> Keypair {
    let prefix = fx["seed_prefix"].as_str().unwrap();
    let label = fx["labels"][key].as_str().unwrap();
    Keypair::new_from_array(
        solana_sha256_hasher::hashv(&[prefix.as_bytes(), label.as_bytes()]).to_bytes(),
    )
}

#[derive(Clone)]
struct Proof {
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    refusal_code: u16,
    net_amount: u64,
    timestamp: i64,
    daily_spent_before: u64,
}

fn proof(fx: &Value, name: &str) -> Proof {
    let s = fx["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == name)
        .unwrap_or_else(|| panic!("senaryo yok: {name}"));
    Proof {
        proof_a: array(s["proof_a"].as_str().unwrap()),
        proof_b: array(s["proof_b"].as_str().unwrap()),
        proof_c: array(s["proof_c"].as_str().unwrap()),
        refusal_code: s["refusal_code"].as_u64().unwrap() as u16,
        net_amount: s["net_amount"].as_str().unwrap().parse().unwrap(),
        timestamp: s["timestamp"].as_i64().unwrap(),
        daily_spent_before: s["daily_spent_before"].as_str().unwrap().parse().unwrap(),
    }
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[VERIFIER_CONFIG_SEED], &square_verifier::ID).0
}

fn release_proof_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[RELEASE_PROOF_SEED, job.as_ref()], &square_verifier::ID).0
}

fn operator_state_address(institution: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[OPERATOR_STATE_SEED, institution.as_ref()],
        &square_verifier::ID,
    )
    .0
}

fn claim_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CLAIM_SEED, job.as_ref()], &square_escrow::ID).0
}

fn escrow_authority() -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_AUTHORITY_SEED], &square_escrow::ID).0
}

fn init_config_ix(admin: &Pubkey, mpp_authority: Pubkey) -> Instruction {
    Instruction {
        program_id: square_verifier::ID,
        accounts: square_verifier::accounts::InitVerifierConfig {
            admin: *admin,
            config: config_address(),
            program: square_verifier::ID,
            program_data: programdata_address(&square_verifier::ID),
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: square_verifier::instruction::InitVerifierConfig {
            escrow_program: square_escrow::ID,
            policy_program: square_policy::ID,
            mpp_authority,
        }
        .data(),
    }
}

/// Fikstürün dünyası: escrow, registry, policy ve verifier yüklü ve kurulu; kurum, agent ve politika
/// devrenin etiketlerinden.
struct ReleaseWorld {
    w: World,
    fx: Value,
    institution: Institution,
    agent: Agent,
    policy: PolicyAccounts,
}

impl ReleaseWorld {
    fn deployed(sigverify: bool) -> Self {
        let fx = fixture();
        let mint = keypair(&fx, "settlementMint");
        let mut w = World::configured(World::deployed_with_mint(sigverify, &mint));
        w.h.deploy_upgradeable("square_verifier", square_verifier::ID, w.admin.pubkey());
        assert_eq!(
            w.h.now(),
            fx["timestamp"].as_i64().unwrap(),
            "dünyanın saati ispatların anı"
        );

        let institution = w.institution_with(keypair(&fx, "institutionWallet"), 10 * AMOUNT);
        let agent = w.register_agent_with_wallet("research-agent", keypair(&fx, "agentWallet"));
        w.screen(&institution.key.pubkey(), ScreeningStatus::Clear);
        w.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
        let policy_fx = &fx["policy"];
        let policy = w.policy_with(
            &institution.key,
            sha256(policy_fx["policy_id"].as_str().unwrap()),
            array(policy_fx["commitment"].as_str().unwrap()),
            policy_fx["daily_ceiling"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
        );
        Self {
            w,
            fx,
            institution,
            agent,
            policy,
        }
    }

    /// Verifier config'i de kurulmuş dünya.
    fn new(sigverify: bool) -> Self {
        let mut r = Self::deployed(sigverify);
        let admin = r.w.admin.insecure_clone();
        r.w.h
            .send(
                &[init_config_ix(&admin.pubkey(), Pubkey::new_unique())],
                &[&admin],
            )
            .expect("init_verifier_config");
        r
    }

    fn proof(&self, name: &str) -> Proof {
        proof(&self.fx, name)
    }

    fn job_address(&self, spec: &str) -> Pubkey {
        job_address(&self.institution.key.pubkey(), &self.spec(spec))
    }

    fn spec(&self, spec: &str) -> [u8; 32] {
        sha256(self.fx["specs"][spec].as_str().unwrap())
    }

    /// `spec` işini policy'yle açar, fonlar, kabul ve teslim ettirir.
    fn delivered_job(&mut self, spec: &str) -> Pubkey {
        let spec_hash = self.spec(spec);
        let institution = self.institution.key.insecure_clone();
        let wallet = self.agent.wallet.insecure_clone();
        let w = &mut self.w;
        let ix = w.create_job_ix(
            &institution.pubkey(),
            self.agent.record,
            Some(self.policy),
            spec_hash,
            AMOUNT,
            w.h.now() + 7 * DAY,
            CHALLENGE,
            w.usdc,
        );
        w.h.send(&[ix], &[&institution]).expect("create_job");
        let job = job_address(&institution.pubkey(), &spec_hash);
        let ix = w.fund_job_ix(&self.institution, &job);
        w.h.send(&[ix], &[&institution]).expect("fund_job");
        let ix = w.accept_ix(&wallet.pubkey(), &job, self.agent.record, spec_hash);
        w.h.send(&[ix], &[&wallet]).expect("accept_job");
        let ix = w.submit_ix(&wallet.pubkey(), &job, self.agent.record, DELIVERY_URI);
        w.h.send(&[ix], &[&wallet]).expect("submit_work");
        job
    }

    fn bind_ix(&self, authority: &Pubkey, job: &Pubkey, policy: Pubkey, p: &Proof) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::SetComplianceProof {
                payer: self.w.h.payer.pubkey(),
                authority: *authority,
                config: config_address(),
                institution: self.policy.institution,
                policy,
                job: *job,
                claim_listing: claim_address(job),
                operator_state: operator_state_address(&self.policy.institution),
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

    fn bind(&mut self, job: &Pubkey, p: &Proof) -> Outcome {
        let ix = self.bind_ix(&self.institution.key.pubkey(), job, self.policy.policy, p);
        let key = self.institution.key.insecure_clone();
        self.w.h.send(&[compute_unit_limit(CU_LIMIT), ix], &[&key])
    }

    fn record_ix(&self, job: &Pubkey, signer: Pubkey) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::RecordRelease {
                escrow_authority: signer,
                config: config_address(),
                release_proof: release_proof_address(job),
                operator_state: operator_state_address(&self.policy.institution),
            }
            .to_account_metas(None),
            data: square_verifier::instruction::RecordRelease {}.data(),
        }
    }

    /// Escrow'un CPI'ı: imzacı escrow programının `["escrow_authority"]` PDA'sı (imza doğrulamasız ortam).
    fn record(&mut self, job: &Pubkey) -> Outcome {
        let ix = self.record_ix(job, escrow_authority());
        self.w.h.send_as(&[ix], &[], &[escrow_authority()])
    }

    fn release_proof(&self, job: &Pubkey) -> ReleaseProof {
        self.w
            .h
            .account(&release_proof_address(job))
            .expect("ReleaseProof")
    }

    fn operator_state(&self) -> OperatorState {
        self.w
            .h
            .account(&operator_state_address(&self.policy.institution))
            .expect("OperatorState")
    }

    /// Escrow'un release'te uygulayacağı kural (BC-24), verifier'ın yazdığı hesaplarla.
    fn fresh_at_release(&self, job: &Pubkey, facts: ReleaseFacts) -> Result<(), Staleness> {
        let proof: contract::ReleaseProof = self
            .w
            .h
            .account(&release_proof_address(job))
            .expect("ReleaseProof");
        let state: contract::OperatorState = self
            .w
            .h
            .account(&operator_state_address(&self.policy.institution))
            .expect("OperatorState");
        check_fresh(&proof, &state, &facts, self.w.h.now())
    }

    fn facts(&self, net_amount: u64) -> ReleaseFacts {
        ReleaseFacts {
            payee: self.agent.wallet.pubkey(),
            net_amount,
            mint: self.w.usdc,
        }
    }
}

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
    let config: VerifierConfig = r.w.h.account(&config_address()).unwrap();
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
fn a_valid_proof_writes_a_compliant_release_proof() {
    let mut r = ReleaseWorld::new(true);
    let job = r.delivered_job("a");
    let p = r.proof("compliant");
    let executed = r.bind(&job, &p).expect("set_compliance_proof");
    cu::within("verifier.set_compliance_proof", &executed, 300_000);

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
    let refused = r.proof("refused_per_tx");
    let executed = r.bind(&job, &refused).expect("ret ispatı");
    let proof = r.release_proof(&job);
    assert_eq!(
        (proof.verdict, proof.refusal_code),
        (ReleaseVerdict::Refused, 1)
    );
    assert_eq!(proof.net_amount, refused.net_amount);
    assert_eq!(event::<ComplianceProofSet>(&executed).refusal_code, 1);

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
        AMOUNT,
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
    let buyer = keypair(&r.fx, "claimBuyer").pubkey();
    // Satılmış alacak. buy_claim BC-25'te gelene kadar listeleme hesabı sözleşmenin düzeniyle yazılır.
    let listing = ClaimListing {
        job,
        seller: r.agent.wallet.pubkey(),
        buyer,
        rent_payer: r.w.h.payer.pubkey(),
        price: 20_000_000,
        face_value: AMOUNT,
        listed_at: r.w.h.now(),
        bought_at: r.w.h.now(),
        status: ClaimStatus::Bought,
        bump: Pubkey::find_program_address(&[CLAIM_SEED, job.as_ref()], &square_escrow::ID).1,
    };
    let mut data = Vec::new();
    listing.try_serialize(&mut data).unwrap();
    let lamports = r.w.h.svm.minimum_balance_for_rent_exemption(data.len());
    r.w.h.set_account(
        claim_address(&job),
        Account {
            lamports,
            data,
            owner: square_escrow::ID,
            executable: false,
            rent_epoch: 0,
        },
    );

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
    let job = r.delivered_job("a");
    r.bind(&job, &r.proof("refused_per_tx"))
        .expect("ret ispatı");
    let executed = r.record(&job).expect("record_release");
    assert!(r.release_proof(&job).consumed);
    let state = r.operator_state();
    assert_eq!((state.daily_spent, state.total_lifetime_payments), (0, 0));
    let recorded: ReleaseRecorded = event(&executed);
    assert_eq!((recorded.net_amount, recorded.daily_spent), (0, 0));
}
