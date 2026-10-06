//! Stripe MPP fiat rayı (BC-37, ADR 0024): fiat iş vault'suz açılır, agent açıkken kabul eder ve teslim
//! eder; kurum Stripe ile öder, MPP authority'nin attestation'ı (aynı tx'te Ed25519 precompile) ve release
//! devresinin gerçek ispatı (`stripe_receipt_hash` ≠ 0) verifier'da işe bağlanır; `finalize_fiat_payment`
//! işi `Released` yapar, günlük sayaç, itibar ve validation kaydı USDC yolundaki gibi yazılır.
//!
//! İspat `tests/fixtures/release-proofs.json`'ın `mpp_fiat` senaryosudur (fiat iş `d`, tutarın tamamı,
//! makbuz commitment'ı sinyal 12). MPP authority'si testin anahtarıdır; config'e `init_verifier_config`
//! ile yazılır, `update_mpp_authority` ile program upgrade'i olmadan değişir.

mod escrow_world;
mod release_world;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use escrow_world::*;
use release_world::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::mpp::attestation_message;
use square_escrow::errors::EscrowError;
use square_escrow::state::{
    AgentReputation, Job, JobStatus, SettlementRail, ValidationOutcome, ValidationRecord,
};
use square_escrow::{FiatJobCreated, Finalized, JobCancelled, ReleaseVerified};
use square_program_tests::{anchor_error, compute_unit_limit, cu, event, Outcome};
use square_registry::ScreeningStatus;
use square_verifier::errors::VerifierError;
use square_verifier::state::{ReleaseVerdict, VerifierConfig};
use square_verifier::{ComplianceProofSet, MppPaymentVerified, VerifierConfigUpdated};

const FIAT: &str = "d";
const SCENARIO: &str = "mpp_fiat";

/// Solana'nın Ed25519 precompile talimatı: tek imza; anahtar, imza ve mesaj talimatın kendi verisinde.
fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    let signature = signer.sign_message(message);
    let public_key_offset: u16 = 16;
    let signature_offset = public_key_offset + 32;
    let message_offset = signature_offset + 64;
    let mut data = vec![1, 0];
    for value in [
        signature_offset,
        u16::MAX,
        public_key_offset,
        u16::MAX,
        message_offset,
        message.len() as u16,
        u16::MAX,
    ] {
        data.extend_from_slice(&value.to_le_bytes());
    }
    data.extend_from_slice(signer.pubkey().as_ref());
    data.extend_from_slice(signature.as_ref());
    data.extend_from_slice(message);
    Instruction {
        program_id: solana_sdk_ids::ed25519_program::ID,
        accounts: vec![],
        data,
    }
}

struct FiatWorld {
    r: ReleaseWorld,
    mpp: Keypair,
}

impl FiatWorld {
    fn new() -> Self {
        let mut r = ReleaseWorld::deployed(true);
        let mpp = Keypair::new();
        let admin = r.w.admin.insecure_clone();
        r.w.h
            .send(&[init_config_ix(&admin.pubkey(), mpp.pubkey())], &[&admin])
            .expect("init_verifier_config");
        Self { r, mpp }
    }

    fn institution(&self) -> Keypair {
        self.r.institution.key.insecure_clone()
    }

    fn create_ix(&self, spec_hash: [u8; 32], amount: u64, deadline: i64) -> Instruction {
        let institution = self.r.institution.key.pubkey();
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::CreateFiatJob {
                payer: self.r.w.h.payer.pubkey(),
                institution,
                config: config_address(),
                agent_record: self.r.agent.record,
                policy: self.r.policy.policy,
                policy_institution: self.r.policy.institution,
                institution_screening: screening_address(&institution),
                agent_screening: screening_address(&self.r.agent.wallet.pubkey()),
                job: job_address(&institution, &spec_hash),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CreateFiatJob {
                spec_hash,
                amount,
                deadline,
            }
            .data(),
        }
    }

    fn create(&mut self) -> Outcome {
        let ix = self.create_ix(
            self.r.spec(FIAT),
            self.r.amount(FIAT),
            self.r.w.h.now() + 7 * DAY,
        );
        let institution = self.institution();
        self.r.w.h.send(&[ix], &[&institution])
    }

    /// Fiat iş açılır, agent kabul eder ve teslim eder.
    fn delivered(&mut self) -> Pubkey {
        self.create().expect("create_fiat_job");
        let job = self.r.job_address(FIAT);
        let wallet = self.r.agent.wallet.insecure_clone();
        let (record, spec) = (self.r.agent.record, self.r.spec(FIAT));
        let w = &mut self.r.w;
        let ix = w.accept_ix(&wallet.pubkey(), &job, record, spec);
        w.h.send(&[ix], &[&wallet]).expect("accept_job");
        let ix = w.submit_ix(&wallet.pubkey(), &job, record, DELIVERY_URI);
        w.h.send(&[ix], &[&wallet]).expect("submit_work");
        job
    }

    fn receipt(&self) -> [u8; 32] {
        let scenario = self.r.fx["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == SCENARIO)
            .unwrap();
        array(scenario["stripe_receipt_hash"].as_str().unwrap())
    }

    fn verify_ix(&self, job: &Pubkey, p: &Proof, receipt: [u8; 32]) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::VerifyMppPaymentProof {
                payer: self.r.w.h.payer.pubkey(),
                authority: self.r.institution.key.pubkey(),
                config: verifier_config_address(),
                institution: self.r.policy.institution,
                policy: self.r.policy.policy,
                job: *job,
                operator_state: operator_state_address(&self.r.policy.institution),
                release_proof: release_proof_address(job),
                instructions: solana_sdk_ids::sysvar::instructions::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_verifier::instruction::VerifyMppPaymentProof {
                proof_a: p.proof_a,
                proof_b: p.proof_b,
                proof_c: p.proof_c,
                stripe_receipt_hash: receipt,
                proof_timestamp: p.timestamp,
            }
            .data(),
        }
    }

    /// Attestation (verilen talimat) ve hemen ardından `verify_mpp_payment_proof`.
    fn verify_with(&mut self, job: &Pubkey, attestation: Option<Instruction>) -> Outcome {
        let p = self.r.proof(SCENARIO);
        let verify = self.verify_ix(job, &p, self.receipt());
        let instructions: Vec<Instruction> = std::iter::once(compute_unit_limit(CU_LIMIT))
            .chain(attestation)
            .chain(std::iter::once(verify))
            .collect();
        let institution = self.institution();
        self.r.w.h.send(&instructions, &[&institution])
    }

    /// `signer`'ın işe, makbuza ve `amount`'a bağlı attestation'ı.
    fn attestation(&self, signer: &Keypair, job: &Pubkey, amount: u64) -> Instruction {
        ed25519_ix(signer, &attestation_message(job, &self.receipt(), amount))
    }

    fn verify(&mut self, job: &Pubkey) -> Outcome {
        let attestation = self.attestation(&self.mpp, job, self.r.amount(FIAT));
        self.verify_with(job, Some(attestation))
    }

    fn finalize_ix(&self, payer: &Pubkey, job: &Pubkey) -> Instruction {
        let state: Job = self.r.w.job(job);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::FinalizeFiatPayment {
                payer: *payer,
                config: config_address(),
                job: *job,
                release_proof: release_proof_address(job),
                operator_state: operator_state_address(&self.r.policy.institution),
                verifier_config: verifier_config_address(),
                verifier_program: square_verifier::ID,
                escrow_authority: escrow_authority_address(),
                agent_reputation: reputation_address(&state.agent_record),
                validation_record: validation_address(job),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::FinalizeFiatPayment {}.data(),
        }
    }

    fn finalize(&mut self, job: &Pubkey) -> Outcome {
        let payer = self.r.w.h.funded(1_000_000_000);
        let ix = self.finalize_ix(&payer.pubkey(), job);
        self.r
            .w
            .h
            .send(&[compute_unit_limit(CU_LIMIT), ix], &[&payer])
    }

    fn cancel(&mut self, job: &Pubkey) -> Outcome {
        let institution = self.institution();
        let ix = Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::InstitutionJob {
                institution: institution.pubkey(),
                job: *job,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CancelFiatJob {}.data(),
        };
        self.r.w.h.send(&[ix], &[&institution])
    }

    fn update_authority_ix(&self, admin: &Pubkey, mpp_authority: Pubkey) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::UpdateMppAuthority {
                admin: *admin,
                config: verifier_config_address(),
            }
            .to_account_metas(None),
            data: square_verifier::instruction::UpdateMppAuthority { mpp_authority }.data(),
        }
    }
}

#[test]
fn a_stripe_payment_settles_a_fiat_job() {
    let mut f = FiatWorld::new();
    let executed = f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    let created: FiatJobCreated = event(&executed);
    assert_eq!(
        (created.job, created.policy, created.amount),
        (job, f.r.policy.policy, f.r.amount(FIAT))
    );
    let state = f.r.w.job(&job);
    assert_eq!(
        (
            state.rail,
            state.status,
            state.challenge_period,
            state.vault_bump
        ),
        (SettlementRail::Fiat, JobStatus::Open, 0, 0)
    );
    // Vault yok: fonlama zincirde değil.
    assert!(f.r.w.h.raw_account(&vault_address(&job)).is_none());

    // Agent açık işi kabul eder ve teslim eder; ödeme Stripe'ta.
    let job = {
        let wallet = f.r.agent.wallet.insecure_clone();
        let (record, spec) = (f.r.agent.record, f.r.spec(FIAT));
        let ix = f.r.w.accept_ix(&wallet.pubkey(), &job, record, spec);
        f.r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
        let ix =
            f.r.w
                .submit_ix(&wallet.pubkey(), &job, record, DELIVERY_URI);
        f.r.w.h.send(&[ix], &[&wallet]).expect("submit_work");
        job
    };
    f.r.w.h.set_time(f.r.proof_time());
    let executed = f.verify(&job).expect("verify_mpp_payment_proof");
    cu::within("verifier.verify_mpp_payment_proof", &executed, 300_000);
    let amount = f.r.amount(FIAT);
    let proof = f.r.release_proof(&job);
    assert_eq!(
        (proof.verdict, proof.refusal_code, proof.consumed),
        (ReleaseVerdict::Compliant, 0, false)
    );
    assert_eq!(
        (proof.payee, proof.net_amount, proof.mint),
        (f.r.agent.wallet.pubkey(), amount, f.r.w.usdc)
    );
    let set: ComplianceProofSet = event(&executed);
    assert_eq!((set.job, set.net_amount), (job, amount));
    let paid: MppPaymentVerified = event(&executed);
    assert_eq!(
        (paid.job, paid.institution, paid.policy),
        (job, f.r.policy.institution, f.r.policy.policy)
    );
    assert_eq!(
        (paid.stripe_receipt_hash, paid.amount),
        (f.receipt(), amount)
    );

    // Challenge penceresi yok: kurumun ödemesi teslimin kabulüdür.
    let executed = f.finalize(&job).expect("finalize_fiat_payment");
    cu::within("escrow.finalize_fiat_payment", &executed, 120_000);
    let state = f.r.w.job(&job);
    assert_eq!(state.status, JobStatus::Released);
    assert!(f.r.release_proof(&job).consumed);
    assert_eq!(f.r.operator_state().daily_spent, amount);
    let record: ValidationRecord = f.r.w.h.account(&validation_address(&job)).unwrap();
    assert_eq!(
        (record.outcome, record.release_proof),
        (
            ValidationOutcome::Verified,
            Some(release_proof_address(&job))
        )
    );
    let reputation: AgentReputation =
        f.r.w
            .h
            .account(&reputation_address(&f.r.agent.record))
            .unwrap();
    assert_eq!(
        (reputation.jobs_completed, reputation.total_earned),
        (1, amount)
    );
    let finalized: Finalized = event(&executed);
    assert_eq!(finalized.keeper_fee, 0);
    let verified: ReleaseVerified = event(&executed);
    assert_eq!(
        (verified.payee, verified.net_amount),
        (f.r.agent.wallet.pubkey(), amount)
    );

    // İş kapandı: validation kaydı bir kez açılır, ikinci finalize reddedilir.
    assert!(f.finalize(&job).is_err());
    assert_eq!(f.r.w.job(&job).status, JobStatus::Released);
}

#[test]
fn only_an_attestation_of_the_config_authority_for_this_job_and_amount_binds() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    f.r.w.h.set_time(f.r.proof_time());
    let amount = f.r.amount(FIAT);
    let invalid = anchor_error(VerifierError::InvalidMppAttestation);

    f.verify_with(&job, None)
        .expect_err("attestation yok")
        .assert_error(invalid);
    let stranger = Keypair::new();
    let wrong_signer = f.attestation(&stranger, &job, amount);
    f.verify_with(&job, Some(wrong_signer))
        .expect_err("başka anahtar")
        .assert_error(invalid);
    let wrong_amount = f.attestation(&f.mpp, &job, amount - 1);
    f.verify_with(&job, Some(wrong_amount))
        .expect_err("başka tutar")
        .assert_error(invalid);
    let other_job = f.attestation(&f.mpp, &f.r.job_address("a"), amount);
    f.verify_with(&job, Some(other_job))
        .expect_err("başka iş")
        .assert_error(invalid);
    // Attestation başka bir makbuzu imzalıyor.
    let other_receipt = ed25519_ix(&f.mpp, &attestation_message(&job, &[9; 32], amount));
    f.verify_with(&job, Some(other_receipt))
        .expect_err("başka makbuz")
        .assert_error(invalid);
    // İmzası geçersiz precompile talimatı tx'i düşürür.
    let mut forged = f.attestation(&f.mpp, &job, amount);
    forged.data[48] ^= 1;
    assert!(f.verify_with(&job, Some(forged)).is_err());

    // Escrow release yolunun sıfır commitment'ı MPP ispatı değildir.
    let p = f.r.proof(SCENARIO);
    let zero = ed25519_ix(&f.mpp, &attestation_message(&job, &[0; 32], amount));
    let verify = f.verify_ix(&job, &p, [0; 32]);
    let institution = f.institution();
    f.r.w
        .h
        .send(
            &[compute_unit_limit(CU_LIMIT), zero, verify],
            &[&institution],
        )
        .expect_err("sıfır makbuz")
        .assert_error(invalid);

    // Doğru attestation, başka bir senaryonun ispatıyla: devre doğrulamaz.
    let wrong_proof = f.r.proof("compliant");
    let attestation = f.attestation(&f.mpp, &job, amount);
    let verify = f.verify_ix(&job, &wrong_proof, f.receipt());
    f.r.w
        .h
        .send(
            &[compute_unit_limit(CU_LIMIT), attestation, verify],
            &[&institution],
        )
        .expect_err("başka ispat")
        .assert_error(anchor_error(VerifierError::InvalidProof));

    // İspatın anı tolerans dışında.
    f.r.w.h.set_time(f.r.proof_time() + 2 * HOUR);
    f.verify(&job)
        .expect_err("bayat")
        .assert_error(anchor_error(VerifierError::StaleProof));
    f.r.w.h.set_time(f.r.proof_time());
    f.verify(&job).expect("doğru attestation ve ispat");
}

#[test]
fn the_admin_rotates_the_authority_without_an_upgrade() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    f.r.w.h.set_time(f.r.proof_time());
    let next = Keypair::new();

    let stranger = f.r.w.h.funded(1_000_000_000);
    let ix = f.update_authority_ix(&stranger.pubkey(), next.pubkey());
    f.r.w
        .h
        .send(&[ix], &[&stranger])
        .expect_err("admin değil")
        .assert_error(anchor_error(VerifierError::Unauthorized));

    let admin = f.r.w.admin.insecure_clone();
    let ix = f.update_authority_ix(&admin.pubkey(), next.pubkey());
    let executed =
        f.r.w
            .h
            .send(&[ix], &[&admin])
            .expect("update_mpp_authority");
    let updated: VerifierConfigUpdated = event(&executed);
    assert_eq!(updated.mpp_authority, next.pubkey());
    let config: VerifierConfig = f.r.w.h.account(&verifier_config_address()).unwrap();
    assert_eq!(config.mpp_authority, next.pubkey());

    // Eski anahtarın attestation'ı artık bağlanmaz, yenisininki bağlanır.
    f.verify(&job)
        .expect_err("eski anahtar")
        .assert_error(anchor_error(VerifierError::InvalidMppAttestation));
    let amount = f.r.amount(FIAT);
    let attestation = f.attestation(&next, &job, amount);
    f.verify_with(&job, Some(attestation))
        .expect("yeni anahtar");
}

#[test]
fn escrow_paths_do_not_apply_to_fiat_jobs_and_fiat_paths_not_to_escrow_jobs() {
    let mut f = FiatWorld::new();
    let job = f.delivered();
    let rail = anchor_error(EscrowError::RailMismatch);

    // Dispute ve alacak fiat işte yok.
    let wallet = f.r.agent.wallet.insecure_clone();
    f.r.w
        .list_claim(&wallet, &job, 1_000_000)
        .expect_err("alacak")
        .assert_error(rail);
    let institution = Institution {
        key: f.institution(),
        token_account: f.r.institution.token_account,
    };
    f.r.w
        .raise_dispute(&institution, &job, 1_000_000)
        .expect_err("dispute")
        .assert_error(rail);

    // Fiat işe USDC ispatı bağlanamaz.
    f.r.w.h.set_time(f.r.proof_time());
    let p = f.r.proof(SCENARIO);
    f.r.bind(&job, &p)
        .expect_err("set_compliance_proof")
        .assert_error(anchor_error(VerifierError::RailMismatch));

    // Escrow işine MPP ispatı bağlanamaz, fiat finalize ve iptal escrow işine uygulanmaz.
    let escrow_job = f.r.delivered_job("a");
    let attestation = f.attestation(&f.mpp, &escrow_job, f.r.amount("a"));
    f.verify_with(&escrow_job, Some(attestation))
        .expect_err("escrow işi")
        .assert_error(anchor_error(VerifierError::RailMismatch));
    f.finalize(&escrow_job)
        .expect_err("escrow işi")
        .assert_error(rail);
    f.cancel(&escrow_job)
        .expect_err("escrow işi")
        .assert_error(rail);

    // İspat bağlanmadan fiat iş kapanmaz.
    f.finalize(&job)
        .expect_err("ispat yok")
        .assert_error(anchor_error(EscrowError::ProofRequired));
}

#[test]
fn a_fiat_job_needs_clear_screenings_and_can_be_cancelled() {
    let mut f = FiatWorld::new();
    let wallet = f.r.agent.wallet.pubkey();
    f.r.w.screen(&wallet, ScreeningStatus::Flagged);
    f.create()
        .expect_err("agent işaretli")
        .assert_error(anchor_error(EscrowError::ScreeningFlagged));
    f.r.w.screen(&wallet, ScreeningStatus::Clear);

    f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    // Fonlama adımı yok; Travel Rule commitment'ı fonlamaya bağlıdır.
    let institution = f.institution();
    let ix =
        f.r.w
            .commit_travel_rule_ix(&institution.pubkey(), &job, [0x2c; 32]);
    f.r.w
        .h
        .send(&[ix], &[&institution])
        .expect_err("travel rule")
        .assert_error(anchor_error(EscrowError::RailMismatch));

    let executed = f.cancel(&job).expect("cancel_fiat_job");
    let cancelled: JobCancelled = event(&executed);
    assert_eq!((cancelled.job, cancelled.refunded_amount), (job, 0));
    assert_eq!(f.r.w.job(&job).status, JobStatus::Cancelled);
    f.cancel(&job)
        .expect_err("iptal edilmiş")
        .assert_error(anchor_error(EscrowError::InvalidStatus));
}

#[test]
fn an_accepted_fiat_job_is_cancelled_only_after_the_deadline() {
    let mut f = FiatWorld::new();
    f.create().expect("create_fiat_job");
    let job = f.r.job_address(FIAT);
    let wallet = f.r.agent.wallet.insecure_clone();
    let ix =
        f.r.w
            .accept_ix(&wallet.pubkey(), &job, f.r.agent.record, f.r.spec(FIAT));
    f.r.w.h.send(&[ix], &[&wallet]).expect("accept_job");
    f.cancel(&job)
        .expect_err("son tarihten önce")
        .assert_error(anchor_error(EscrowError::DeadlineNotExpired));
    f.r.w.h.advance(8 * DAY);
    f.cancel(&job).expect("son tarihten sonra");
}

/// `rail` alanından önce açılmış job hesapları (bir bayt kısa) `Escrow` okunur ve yazılabilir.
#[test]
fn jobs_created_before_the_rail_field_read_as_escrow() {
    let mut w = World::new(true);
    let (institution, _agent, job) = w.open_job(false);
    let mut account = w.h.raw_account(&job).unwrap();
    assert_eq!(account.data.last(), Some(&0));
    account.data.truncate(account.data.len() - 1);
    w.h.set_account(job, account);

    let ix = w.fund_job_ix(&institution, &job);
    let key = institution.key.insecure_clone();
    w.h.send(&[ix], &[&key]).expect("fund_job");
    let state = w.job(&job);
    assert_eq!(
        (state.rail, state.status),
        (SettlementRail::Escrow, JobStatus::Funded)
    );
}
