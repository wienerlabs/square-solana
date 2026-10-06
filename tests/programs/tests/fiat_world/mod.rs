//! Fiat rayının (BC-37, ADR 0024) test dünyası: release fikstürünün dünyası, testin MPP authority anahtarı
//! config'te; fiat işin talimatları, Ed25519 precompile attestation'ı ve `verify_mpp_payment_proof`.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::mpp::attestation_message;
use square_escrow::state::Job;
use square_program_tests::{compute_unit_limit, Outcome};

use crate::escrow_world::*;
use crate::release_world::*;

pub const FIAT: &str = "d";
pub const SCENARIO: &str = "mpp_fiat";

/// Solana'nın Ed25519 precompile talimatı: tek imza; anahtar, imza ve mesaj talimatın kendi verisinde.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
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

pub struct FiatWorld {
    pub r: ReleaseWorld,
    pub mpp: Keypair,
}

impl FiatWorld {
    pub fn new() -> Self {
        let mut r = ReleaseWorld::deployed(true);
        let mpp = Keypair::new();
        let admin = r.w.admin.insecure_clone();
        r.w.h
            .send(&[init_config_ix(&admin.pubkey(), mpp.pubkey())], &[&admin])
            .expect("init_verifier_config");
        Self { r, mpp }
    }

    pub fn institution(&self) -> Keypair {
        self.r.institution.key.insecure_clone()
    }

    pub fn create_ix(&self, spec_hash: [u8; 32], amount: u64, deadline: i64) -> Instruction {
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

    pub fn create(&mut self) -> Outcome {
        let ix = self.create_ix(
            self.r.spec(FIAT),
            self.r.amount(FIAT),
            self.r.w.h.now() + 7 * DAY,
        );
        let institution = self.institution();
        self.r.w.h.send(&[ix], &[&institution])
    }

    /// Fiat iş açılır, agent kabul eder ve teslim eder.
    pub fn delivered(&mut self) -> Pubkey {
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

    pub fn receipt(&self) -> [u8; 32] {
        let scenario = self.r.fx["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == SCENARIO)
            .unwrap();
        array(scenario["stripe_receipt_hash"].as_str().unwrap())
    }

    pub fn verify_ix(&self, job: &Pubkey, p: &Proof, receipt: [u8; 32]) -> Instruction {
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
    pub fn verify_with(&mut self, job: &Pubkey, attestation: Option<Instruction>) -> Outcome {
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
    pub fn attestation(&self, signer: &Keypair, job: &Pubkey, amount: u64) -> Instruction {
        ed25519_ix(signer, &attestation_message(job, &self.receipt(), amount))
    }

    pub fn verify(&mut self, job: &Pubkey) -> Outcome {
        let attestation = self.attestation(&self.mpp, job, self.r.amount(FIAT));
        self.verify_with(job, Some(attestation))
    }

    pub fn finalize_ix(&self, payer: &Pubkey, job: &Pubkey) -> Instruction {
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

    pub fn finalize(&mut self, job: &Pubkey) -> Outcome {
        let payer = self.r.w.h.funded(1_000_000_000);
        let ix = self.finalize_ix(&payer.pubkey(), job);
        self.r
            .w
            .h
            .send(&[compute_unit_limit(CU_LIMIT), ix], &[&payer])
    }

    pub fn cancel_ix(&self, job: &Pubkey) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::InstitutionJob {
                institution: self.r.institution.key.pubkey(),
                job: *job,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CancelFiatJob {}.data(),
        }
    }

    pub fn cancel(&mut self, job: &Pubkey) -> Outcome {
        let institution = self.institution();
        let ix = self.cancel_ix(job);
        self.r.w.h.send(&[ix], &[&institution])
    }

    pub fn update_authority_ix(&self, admin: &Pubkey, mpp_authority: Pubkey) -> Instruction {
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
