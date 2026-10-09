//! Verifier ve finalize testlerinin ortak dünyası: escrow, registry, policy ve verifier yüklü ve kurulu;
//! kurum, agent cüzdanı, settlement mint'i ve politika release ispatı fikstürünün etiketlerinden
//! (tests/fixtures/release-proofs.json, circuits/payment-compliance/scripts/program-proofs.mjs).
//! Dünyanın saati ispatların anından iki saat önce başlar: kurum kabul öncesi ön-ispatı bağlar (ADR 0028), iş
//! teslim edilir, bir saatlik challenge penceresi kapanır, ispat bağlanır ve release aynı UTC gününde yapılır
//! (ADR 0012).
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::contract::square_verifier_contract::accounts as contract;
use square_common::release::{check_fresh, ReleaseFacts, Staleness};
use square_common::seeds::{ESCROW_AUTHORITY_SEED, OPERATOR_STATE_SEED, RELEASE_PROOF_SEED};
use square_program_tests::token;
use square_program_tests::{compute_unit_limit, programdata_address, Outcome};
use square_registry::ScreeningStatus;
use square_verifier::state::{OperatorState, ReleaseProof};

use crate::escrow_world::*;

pub const FIXTURE: &str = include_str!("../fixtures/release-proofs.json");
pub const DELIVERY_URI: &str = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
/// Groth16 doğrulaması talimat başına varsayılan 200 000 CU'yu aşar.
pub const CU_LIMIT: u32 = 1_400_000;

pub fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("release-proofs.json")
}

pub fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
        .collect()
}

pub fn array<const N: usize>(hex: &str) -> [u8; N] {
    bytes(hex).try_into().expect("uzunluk")
}

pub fn sha256(text: &str) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[text.as_bytes()]).to_bytes()
}

/// Devrenin test anahtarları: tohum `sha256(seed_prefix ‖ etiket)` (release-input.mjs `keyFromLabel`).
pub fn keypair(fx: &Value, key: &str) -> Keypair {
    let prefix = fx["seed_prefix"].as_str().unwrap();
    let label = fx["labels"][key].as_str().unwrap();
    Keypair::new_from_array(
        solana_sha256_hasher::hashv(&[prefix.as_bytes(), label.as_bytes()]).to_bytes(),
    )
}

#[derive(Clone)]
pub struct Proof {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub refusal_code: u16,
    pub net_amount: u64,
    pub timestamp: i64,
    pub daily_spent_before: u64,
}

pub fn proof(fx: &Value, name: &str) -> Proof {
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

pub fn release_proof_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[RELEASE_PROOF_SEED, job.as_ref()], &square_verifier::ID).0
}

pub fn operator_state_address(institution: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[OPERATOR_STATE_SEED, institution.as_ref()],
        &square_verifier::ID,
    )
    .0
}

pub fn escrow_authority() -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_AUTHORITY_SEED], &square_escrow::ID).0
}

pub fn init_config_ix(admin: &Pubkey, mpp_authority: Pubkey) -> Instruction {
    Instruction {
        program_id: square_verifier::ID,
        accounts: square_verifier::accounts::InitVerifierConfig {
            admin: *admin,
            config: verifier_config_address(),
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
pub struct ReleaseWorld {
    pub w: World,
    pub fx: Value,
    pub institution: Institution,
    pub agent: Agent,
    pub policy: PolicyAccounts,
}

impl ReleaseWorld {
    pub fn deployed(sigverify: bool) -> Self {
        let fx = fixture();
        let mint = keypair(&fx, "settlementMint");
        let mut w = World::configured(World::deployed_with_mint(sigverify, &mint));
        w.h.deploy_upgradeable("square_verifier", square_verifier::ID, w.admin.pubkey());
        // İş teslim edilir, bir saatlik pencere kapanır; ispat ve release aynı UTC gününde.
        w.h.set_time(fx["timestamp"].as_i64().unwrap() - 2 * HOUR);

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
    pub fn new(sigverify: bool) -> Self {
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

    pub fn proof(&self, name: &str) -> Proof {
        proof(&self.fx, name)
    }

    pub fn job_address(&self, spec: &str) -> Pubkey {
        job_address(&self.institution.key.pubkey(), &self.spec(spec))
    }

    pub fn spec(&self, spec: &str) -> [u8; 32] {
        sha256(self.fx["specs"][spec].as_str().unwrap())
    }

    /// `spec` işinin tutarı (fikstür; ispattaki net bu tutardan keeper ücreti düşülerek bulunur).
    pub fn amount(&self, spec: &str) -> u64 {
        self.fx["amounts"][spec].as_str().unwrap().parse().unwrap()
    }

    /// İspatların anı (fikstür).
    pub fn proof_time(&self) -> i64 {
        self.fx["timestamp"].as_i64().unwrap()
    }

    /// `spec` işini policy'yle açar ve fonlar; challenge penceresi bir saat.
    pub fn funded_job(&mut self, spec: &str) -> Pubkey {
        let amount = self.amount(spec);
        let spec_hash = self.spec(spec);
        let institution = self.institution.key.insecure_clone();
        let w = &mut self.w;
        let ix = w.create_job_ix(
            &institution.pubkey(),
            self.agent.record,
            Some(self.policy),
            spec_hash,
            amount,
            w.h.now() + 7 * DAY,
            HOUR as u64,
            w.usdc,
        );
        w.h.send(&[ix], &[&institution]).expect("create_job");
        let job = job_address(&institution.pubkey(), &spec_hash);
        let ix = w.fund_job_ix(&self.institution, &job);
        w.h.send(&[ix], &[&institution]).expect("fund_job");
        job
    }

    /// `spec` işini policy'yle açar, fonlar, ön-ispatı bağlar (ADR 0028), kabul ve teslim ettirir.
    pub fn delivered_job(&mut self, spec: &str) -> Pubkey {
        let spec_hash = self.spec(spec);
        let wallet = self.agent.wallet.insecure_clone();
        let job = self.funded_job(spec);
        self.preflight(&job, spec);
        let w = &mut self.w;
        let ix = w.accept_ix(&wallet.pubkey(), &job, self.agent.record, spec_hash);
        w.h.send(&[ix], &[&wallet]).expect("accept_job");
        let ix = w.submit_ix(&wallet.pubkey(), &job, self.agent.record, DELIVERY_URI);
        w.h.send(&[ix], &[&wallet]).expect("submit_work");
        job
    }

    pub fn bind_ix(
        &self,
        authority: &Pubkey,
        job: &Pubkey,
        policy: Pubkey,
        p: &Proof,
    ) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::SetComplianceProof {
                payer: self.w.h.payer.pubkey(),
                authority: *authority,
                config: verifier_config_address(),
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

    /// Kabul öncesi ön-ispat (ADR 0028): net işin tutarı, payee agent cüzdanı, sayaç 0; sinyalleri verifier
    /// job'dan kurar.
    pub fn preflight_ix(
        &self,
        authority: &Pubkey,
        job: &Pubkey,
        policy: Pubkey,
        p: &Proof,
    ) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::SetPreflightProof {
                payer: self.w.h.payer.pubkey(),
                authority: *authority,
                config: verifier_config_address(),
                institution: self.policy.institution,
                policy,
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

    /// Fikstürün `preflight_<spec>` ön-ispatını bağlar. Ön-ispat kabulden önceki an içindir (fikstürde
    /// ispatların anından iki saat önce); dünyanın saati ilerlemişse bağlama o ana alınır, kabul ve sonrası
    /// dünyanın saatinde kalır (escrow ön-ispatın anına bakmaz).
    pub fn preflight(&mut self, job: &Pubkey, spec: &str) {
        let preflight = self.proof(&format!("preflight_{spec}"));
        let now = self.w.h.now();
        self.w.h.set_time(preflight.timestamp);
        self.bind_preflight(job, &preflight)
            .expect("set_preflight_proof");
        self.w.h.set_time(now);
    }

    pub fn bind_preflight(&mut self, job: &Pubkey, p: &Proof) -> Outcome {
        let ix = self.preflight_ix(&self.institution.key.pubkey(), job, self.policy.policy, p);
        let key = self.institution.key.insecure_clone();
        self.w.h.send(&[compute_unit_limit(CU_LIMIT), ix], &[&key])
    }

    pub fn bind(&mut self, job: &Pubkey, p: &Proof) -> Outcome {
        let ix = self.bind_ix(&self.institution.key.pubkey(), job, self.policy.policy, p);
        let key = self.institution.key.insecure_clone();
        self.w.h.send(&[compute_unit_limit(CU_LIMIT), ix], &[&key])
    }

    pub fn record_ix(&self, job: &Pubkey, signer: Pubkey) -> Instruction {
        Instruction {
            program_id: square_verifier::ID,
            accounts: square_verifier::accounts::RecordRelease {
                escrow_authority: signer,
                config: verifier_config_address(),
                release_proof: release_proof_address(job),
                operator_state: operator_state_address(&self.policy.institution),
            }
            .to_account_metas(None),
            data: square_verifier::instruction::RecordRelease {}.data(),
        }
    }

    /// Escrow'un CPI'ı: imzacı escrow programının `["escrow_authority"]` PDA'sı (imza doğrulamasız ortam).
    pub fn record(&mut self, job: &Pubkey) -> Outcome {
        let ix = self.record_ix(job, escrow_authority());
        self.w.h.send_as(&[ix], &[], &[escrow_authority()])
    }

    pub fn release_proof(&self, job: &Pubkey) -> ReleaseProof {
        self.w
            .h
            .account(&release_proof_address(job))
            .expect("ReleaseProof")
    }

    pub fn operator_state(&self) -> OperatorState {
        self.w
            .h
            .account(&operator_state_address(&self.policy.institution))
            .expect("OperatorState")
    }

    /// Escrow'un release'te uygulayacağı kural (BC-24), verifier'ın yazdığı hesaplarla.
    pub fn fresh_at_release(&self, job: &Pubkey, facts: ReleaseFacts) -> Result<(), Staleness> {
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

    pub fn facts(&self, net_amount: u64) -> ReleaseFacts {
        ReleaseFacts {
            payee: self.agent.wallet.pubkey(),
            net_amount,
            mint: self.w.usdc,
        }
    }

    /// Agent alacağı fikstürün alıcısına (`claimBuyer`) satar; politikanın alıcı listesi kısıtsız.
    pub fn sell_claim_to_fixture_buyer(&mut self, job: &Pubkey) -> Pubkey {
        let buyer = self
            .w
            .buyer_with(keypair(&self.fx, "claimBuyer"), CLAIM_PRICE);
        self.w.sell_claim(&self.agent, job, &buyer);
        buyer.key.pubkey()
    }

    /// Agent alacağı politikanın engelli adresine (`blockedWallet`) satar: registry'de screening'i temiz,
    /// kurumun gizli politikasında engelli. Release kesin rettir; ADR 0028'den sonra kalıcı retin tek yolu budur.
    pub fn sell_claim_to_blocked_buyer(&mut self, job: &Pubkey) -> Pubkey {
        let buyer = self
            .w
            .buyer_with(keypair(&self.fx, "blockedWallet"), CLAIM_PRICE);
        self.w.sell_claim(&self.agent, job, &buyer);
        buyer.key.pubkey()
    }

    /// Policy'li işin ispat hesapları.
    pub fn gate(&self, job: &Pubkey) -> GateAccounts {
        GateAccounts {
            release_proof: release_proof_address(job),
            operator_state: operator_state_address(&self.policy.institution),
        }
    }

    /// Agent'a ödenecek settlement: payee agent cüzdanı, keeper'ın token hesabı ayrı.
    pub fn settlement(&mut self, keeper: &Keypair, payee: Pubkey) -> Settlement {
        let usdc = self.w.usdc;
        Settlement {
            payee,
            payee_token_account: token::create_ata(&mut self.w.h, &payee, &usdc),
            institution_token_account: self.institution.token_account,
            keeper_token_account: token::create_ata(&mut self.w.h, &keeper.pubkey(), &usdc),
        }
    }

    pub fn finalize(&mut self, keeper: &Keypair, job: &Pubkey, settlement: Settlement) -> Outcome {
        let ix = self
            .w
            .finalize_ix(&keeper.pubkey(), job, settlement, Some(self.gate(job)));
        self.w
            .h
            .send(&[compute_unit_limit(CU_LIMIT), ix], &[keeper])
    }
}
