//! Escrow testlerinin ortak dünyası (BC-22). Escrow, registry ve policy programları yüklenir; agent kaydı,
//! screening, kurum ve politika programların kendi instruction'larıyla kurulur, USDC SPL Token programıyla
//! basılır. Hesap durumu elle yazılmaz.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::{
    AGENT_SEED, CLAIM_SEED, CONFIG_SEED, ESCROW_AUTHORITY_SEED, INSTITUTION_SEED, JOB_SEED,
    POLICY_SEED, REGISTRY_CONFIG_SEED, REPUTATION_SEED, SCREENING_SEED, VALIDATION_SEED,
    VAULT_SEED, VERIFIER_CONFIG_SEED,
};
use square_escrow::state::{EscrowConfig, Job};
use square_escrow::{EscrowParams, LinkedPrograms};
use square_program_tests::token::{self, TOKEN_PROGRAM_ID};
use square_program_tests::{programdata_address, Harness, Outcome};
use square_registry::{AgentStatus, ScreeningStatus};

pub const NOW: i64 = 1_790_000_000;
pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 86_400;
pub const SCREENING_TTL: i64 = 30 * DAY;
/// 250 USDC (6 ondalık).
pub const AMOUNT: u64 = 250_000_000;
pub const CHALLENGE: u64 = 24 * HOUR as u64;
pub const SPEC: [u8; 32] = [0x51; 32];
pub const WORK: [u8; 32] = [0xa7; 32];
pub const COMMITMENT: [u8; 32] = [0x2c; 32];
pub const CEILING: u64 = 1_000_000_000;
/// `open_job(true)`'nun politikası.
pub const POLICY_ID: [u8; 32] = [7; 32];
const LAMPORTS: u64 = 1_000_000_000;

mod claims;
// Alacak yardımcılarını kullanmayan test binary'leri de bu modülü içerir.
#[allow(unused_imports)]
pub use claims::*;

pub fn params() -> EscrowParams {
    EscrowParams {
        min_challenge_period: HOUR as u64,
        max_challenge_period: 7 * DAY as u64,
        min_bond_bps: 500,
        min_bond_absolute: 1_000_000,
        keeper_fee_bps: 50,
        proof_timeout_secs: DAY,
        dispute_timeout_secs: 3 * DAY,
        travel_rule_threshold: 0,
    }
}

pub fn linked() -> LinkedPrograms {
    LinkedPrograms {
        registry_program: square_registry::ID,
        policy_program: square_policy::ID,
        verifier_program: square_verifier::ID,
    }
}

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &square_escrow::ID).0
}

pub fn job_address(institution: &Pubkey, spec_hash: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[JOB_SEED, institution.as_ref(), spec_hash],
        &square_escrow::ID,
    )
    .0
}

pub fn vault_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, job.as_ref()], &square_escrow::ID).0
}

pub fn claim_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[CLAIM_SEED, job.as_ref()], &square_escrow::ID).0
}

pub fn reputation_address(agent_record: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[REPUTATION_SEED, agent_record.as_ref()],
        &square_escrow::ID,
    )
    .0
}

pub fn validation_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[VALIDATION_SEED, job.as_ref()], &square_escrow::ID).0
}

pub fn escrow_authority_address() -> Pubkey {
    Pubkey::find_program_address(&[ESCROW_AUTHORITY_SEED], &square_escrow::ID).0
}

pub fn verifier_config_address() -> Pubkey {
    Pubkey::find_program_address(&[VERIFIER_CONFIG_SEED], &square_verifier::ID).0
}

pub fn screening_address(wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SCREENING_SEED, wallet.as_ref()], &square_registry::ID).0
}

pub fn agent_record_address(owner: &Pubkey, agent_id: &str) -> Pubkey {
    Pubkey::find_program_address(
        &[AGENT_SEED, owner.as_ref(), agent_id.as_bytes()],
        &square_registry::ID,
    )
    .0
}

pub fn institution_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[INSTITUTION_SEED, owner.as_ref()], &square_policy::ID).0
}

pub fn policy_address(institution: &Pubkey, policy_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(
        &[POLICY_SEED, institution.as_ref(), policy_id],
        &square_policy::ID,
    )
    .0
}

/// Registry'de kayıtlı agent: kaydı yöneten `owner`, işleri imzalayan `wallet`, kaydın adresi.
pub struct Agent {
    pub owner: Keypair,
    pub wallet: Keypair,
    pub record: Pubkey,
}

/// Kurum cüzdanı (lamport'u yok: rent ve ücreti `payer` öder) ve USDC token hesabı.
pub struct Institution {
    pub key: Keypair,
    pub token_account: Pubkey,
}

/// `finalize_payment`'ın token hesapları ve ödenecek taraf.
#[derive(Clone, Copy)]
pub struct Settlement {
    /// Ödenecek taraf (agent cüzdanı ya da alacağın alıcısı); screening kaydı buna göre geçer.
    pub payee: Pubkey,
    pub payee_token_account: Pubkey,
    pub institution_token_account: Pubkey,
    pub keeper_token_account: Pubkey,
}

/// Policy'li işin ispat hesapları (square_verifier).
#[derive(Clone, Copy)]
pub struct GateAccounts {
    pub release_proof: Pubkey,
    pub operator_state: Pubkey,
}

/// square_policy'de kurum ve politika: (`Policy`, `Institution` PDA'ları).
#[derive(Clone, Copy)]
pub struct PolicyAccounts {
    pub policy: Pubkey,
    pub institution: Pubkey,
}

pub struct World {
    pub h: Harness,
    pub admin: Keypair,
    pub screener: Keypair,
    pub mint_authority: Keypair,
    pub usdc: Pubkey,
}

impl World {
    /// Programlar yüklü, registry config'i kurulu, escrow config'i kurulmamış.
    pub fn deployed(sigverify: bool) -> Self {
        Self::deployed_with_mint(sigverify, &Keypair::new())
    }

    /// [`World::deployed`]; settlement mint'i `mint` anahtarının adresinde (adresi önceden bilinmesi
    /// gereken fikstürler için, ör. release ispatının mint sinyali).
    pub fn deployed_with_mint(sigverify: bool, mint: &Keypair) -> Self {
        let mut h = if sigverify {
            Harness::new()
        } else {
            Harness::without_sigverify()
        };
        let admin = Keypair::new();
        h.svm.airdrop(&admin.pubkey(), LAMPORTS).expect("airdrop");
        h.deploy_upgradeable("square_escrow", square_escrow::ID, admin.pubkey());
        h.deploy_upgradeable("square_registry", square_registry::ID, admin.pubkey());
        h.deploy("square_policy", square_policy::ID);
        h.set_time(NOW);

        let screener = Keypair::new();
        let registry_config =
            Pubkey::find_program_address(&[REGISTRY_CONFIG_SEED], &square_registry::ID).0;
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::InitRegistryConfig {
                admin: admin.pubkey(),
                config: registry_config,
                program: square_registry::ID,
                program_data: programdata_address(&square_registry::ID),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_registry::instruction::InitRegistryConfig {
                screener_authority: screener.pubkey(),
                screening_ttl_secs: SCREENING_TTL,
            }
            .data(),
        };
        h.send(&[ix], &[&admin]).expect("init_registry_config");

        let mint_authority = Keypair::new();
        let usdc =
            token::create_mint_at(&mut h, mint, &mint_authority.pubkey(), token::USDC_DECIMALS);
        Self {
            h,
            admin,
            screener,
            mint_authority,
            usdc,
        }
    }

    /// Escrow config'i de kurulmuş dünya.
    pub fn new(sigverify: bool) -> Self {
        Self::configured(Self::deployed(sigverify))
    }

    /// Escrow config'ini kurar (3 arbitrator, M = 2, [`params`]).
    pub fn configured(mut w: Self) -> Self {
        let ix = w.init_config_ix(
            &w.admin.pubkey(),
            w.usdc,
            vec![
                Pubkey::new_unique(),
                Pubkey::new_unique(),
                Pubkey::new_unique(),
            ],
            2,
            params(),
        );
        let admin = w.admin.insecure_clone();
        w.h.send(&[ix], &[&admin]).expect("init_config");
        w
    }

    pub fn init_config_ix(
        &self,
        admin: &Pubkey,
        settlement_mint: Pubkey,
        arbitrators: Vec<Pubkey>,
        threshold: u8,
        params: EscrowParams,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::InitConfig {
                admin: *admin,
                config: config_address(),
                program: square_escrow::ID,
                program_data: programdata_address(&square_escrow::ID),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::InitConfig {
                settlement_mint,
                arbitrators,
                threshold,
                params,
                linked: linked(),
            }
            .data(),
        }
    }

    pub fn update_params_ix(&self, admin: &Pubkey, params: EscrowParams) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::UpdateConfig {
                admin: *admin,
                config: config_address(),
            }
            .to_account_metas(None),
            data: square_escrow::instruction::UpdateParams { params }.data(),
        }
    }

    pub fn config(&self) -> EscrowConfig {
        self.h.account(&config_address()).expect("EscrowConfig")
    }

    pub fn job(&self, job: &Pubkey) -> Job {
        self.h.account(job).expect("Job")
    }

    pub fn balance(&self, token_account: &Pubkey) -> Option<u64> {
        token::balance(&self.h, token_account)
    }

    // ------------------------------------------------------------------ registry ve policy

    pub fn register_agent(&mut self, agent_id: &str) -> Agent {
        self.register_agent_with_wallet(agent_id, Keypair::new())
    }

    pub fn register_agent_with_wallet(&mut self, agent_id: &str, wallet: Keypair) -> Agent {
        let owner = self.h.funded(LAMPORTS);
        let record = agent_record_address(&owner.pubkey(), agent_id);
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::RegisterAgent {
                payer: self.h.payer.pubkey(),
                owner: owner.pubkey(),
                agent_record: record,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_registry::instruction::RegisterAgent {
                agent_id: agent_id.to_string(),
                agent_card_uri: String::new(),
                agent_card_hash: [0; 32],
                wallet: wallet.pubkey(),
            }
            .data(),
        };
        self.h.send(&[ix], &[&owner]).expect("register_agent");
        Agent {
            owner,
            wallet,
            record,
        }
    }

    pub fn set_agent_status(&mut self, agent: &Agent, status: AgentStatus) -> Outcome {
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::SetAgentStatus {
                owner: agent.owner.pubkey(),
                agent_record: agent.record,
            }
            .to_account_metas(None),
            data: square_registry::instruction::SetAgentStatus { status }.data(),
        };
        self.h.send(&[ix], &[&agent.owner])
    }

    pub fn deregister_agent(&mut self, agent: &Agent) -> Outcome {
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::DeregisterAgent {
                owner: agent.owner.pubkey(),
                agent_record: agent.record,
            }
            .to_account_metas(None),
            data: square_registry::instruction::DeregisterAgent {}.data(),
        };
        self.h.send(&[ix], &[&agent.owner])
    }

    /// Kaydın cüzdanını değiştirir (registry `update_agent`).
    pub fn rotate_wallet(&mut self, agent: &Agent, wallet: Pubkey) -> Outcome {
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::UpdateAgent {
                owner: agent.owner.pubkey(),
                agent_record: agent.record,
            }
            .to_account_metas(None),
            data: square_registry::instruction::UpdateAgent {
                agent_card_uri: String::new(),
                agent_card_hash: [0; 32],
                wallet,
            }
            .data(),
        };
        self.h.send(&[ix], &[&agent.owner])
    }

    pub fn screen(&mut self, wallet: &Pubkey, status: ScreeningStatus) {
        let registry_config =
            Pubkey::find_program_address(&[REGISTRY_CONFIG_SEED], &square_registry::ID).0;
        let ix = Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::RecordScreening {
                payer: self.h.payer.pubkey(),
                screener_authority: self.screener.pubkey(),
                config: registry_config,
                screening_record: screening_address(wallet),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_registry::instruction::RecordScreening {
                wallet: *wallet,
                status,
                source_hash: [0x5c; 32],
            }
            .data(),
        };
        let screener = self.screener.insecure_clone();
        self.h.send(&[ix], &[&screener]).expect("record_screening");
    }

    /// `amount` USDC'si olan kurum cüzdanı.
    pub fn institution(&mut self, amount: u64) -> Institution {
        self.institution_with(Keypair::new(), amount)
    }

    pub fn institution_with(&mut self, key: Keypair, amount: u64) -> Institution {
        let token_account = token::create_ata(&mut self.h, &key.pubkey(), &self.usdc);
        let mint_authority = self.mint_authority.insecure_clone();
        token::mint_to(
            &mut self.h,
            &self.usdc,
            &mint_authority,
            &token_account,
            amount,
        );
        Institution { key, token_account }
    }

    /// `owner` için square_policy kurumu ve `policy_id` politikası.
    pub fn policy(&mut self, owner: &Keypair, policy_id: [u8; 32]) -> PolicyAccounts {
        self.policy_with(owner, policy_id, COMMITMENT, CEILING)
    }

    pub fn policy_with(
        &mut self,
        owner: &Keypair,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> PolicyAccounts {
        let institution = institution_address(&owner.pubkey());
        let init = Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::InitInstitution {
                payer: self.h.payer.pubkey(),
                authority: owner.pubkey(),
                institution,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_policy::instruction::InitInstitution {
                name: "Research procurement".to_string(),
            }
            .data(),
        };
        self.h.send(&[init], &[owner]).expect("init_institution");
        let policy = policy_address(&institution, &policy_id);
        let set = self.set_policy_ix(
            &owner.pubkey(),
            institution,
            policy_id,
            commitment,
            daily_ceiling,
        );
        self.h.send(&[set], &[owner]).expect("set_policy");
        PolicyAccounts {
            policy,
            institution,
        }
    }

    pub fn set_policy_ix(
        &self,
        authority: &Pubkey,
        institution: Pubkey,
        policy_id: [u8; 32],
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::SetPolicy {
                payer: self.h.payer.pubkey(),
                authority: *authority,
                institution,
                policy: policy_address(&institution, &policy_id),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_policy::instruction::SetPolicy {
                policy_id,
                commitment,
                daily_ceiling,
            }
            .data(),
        }
    }

    // ------------------------------------------------------------------ escrow

    #[allow(clippy::too_many_arguments)]
    pub fn create_job_ix(
        &self,
        institution: &Pubkey,
        agent_record: Pubkey,
        policy: Option<PolicyAccounts>,
        spec_hash: [u8; 32],
        amount: u64,
        deadline: i64,
        challenge_period: u64,
        mint: Pubkey,
    ) -> Instruction {
        let job = job_address(institution, &spec_hash);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::CreateJob {
                payer: self.h.payer.pubkey(),
                institution: *institution,
                config: config_address(),
                agent_record,
                policy: policy.map(|p| p.policy),
                policy_institution: policy.map(|p| p.institution),
                job,
                vault: vault_address(&job),
                mint,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CreateJob {
                spec_hash,
                amount,
                deadline,
                challenge_period,
            }
            .data(),
        }
    }

    /// Varsayılan değerlerle `create_job` talimatı (deadline bir hafta sonra).
    pub fn default_create_ix(
        &self,
        institution: &Pubkey,
        agent: &Agent,
        policy: Option<PolicyAccounts>,
    ) -> Instruction {
        self.create_job_ix(
            institution,
            agent.record,
            policy,
            SPEC,
            AMOUNT,
            self.h.now() + 7 * DAY,
            CHALLENGE,
            self.usdc,
        )
    }

    pub fn fund_job_ix(&self, institution: &Institution, job: &Pubkey) -> Instruction {
        self.fund_job_ix_with(
            &institution.key.pubkey(),
            job,
            institution.token_account,
            vault_address(job),
        )
    }

    pub fn fund_job_ix_with(
        &self,
        institution: &Pubkey,
        job: &Pubkey,
        institution_token_account: Pubkey,
        vault: Pubkey,
    ) -> Instruction {
        let agent_wallet = self.job(job).agent_wallet;
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::FundJob {
                institution: *institution,
                config: config_address(),
                job: *job,
                vault,
                institution_token_account,
                mint: self.usdc,
                institution_screening: screening_address(institution),
                agent_screening: screening_address(&agent_wallet),
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::FundJob {}.data(),
        }
    }

    pub fn accept_ix(
        &self,
        agent: &Pubkey,
        job: &Pubkey,
        agent_record: Pubkey,
        spec: [u8; 32],
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::AgentJob {
                agent: *agent,
                job: *job,
                agent_record,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::AcceptJob { spec_hash: spec }.data(),
        }
    }

    pub fn submit_ix(
        &self,
        agent: &Pubkey,
        job: &Pubkey,
        agent_record: Pubkey,
        delivery_uri: &str,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::AgentJob {
                agent: *agent,
                job: *job,
                agent_record,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::SubmitWork {
                work_hash: WORK,
                delivery_uri: delivery_uri.to_string(),
            }
            .data(),
        }
    }

    pub fn cancel_ix(
        &self,
        institution: &Pubkey,
        job: &Pubkey,
        institution_token_account: Pubkey,
        vault: Pubkey,
        rent_payer: Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::CancelJob {
                institution: *institution,
                job: *job,
                vault,
                institution_token_account,
                mint: self.usdc,
                rent_payer,
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::CancelJob {}.data(),
        }
    }

    /// `finalize_payment`; `gate` policy'li işte ispat hesapları, policy'siz işte `None`.
    pub fn finalize_ix(
        &self,
        keeper: &Pubkey,
        job: &Pubkey,
        settlement: Settlement,
        gate: Option<GateAccounts>,
    ) -> Instruction {
        let state = self.job(job);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::FinalizePayment {
                keeper: *keeper,
                config: config_address(),
                job: *job,
                vault: vault_address(job),
                claim_listing: claim_address(job),
                payee_token_account: settlement.payee_token_account,
                institution_token_account: settlement.institution_token_account,
                keeper_token_account: settlement.keeper_token_account,
                mint: self.usdc,
                payee_screening: screening_address(&settlement.payee),
                release_proof: gate.map(|g| g.release_proof),
                operator_state: gate.map(|g| g.operator_state),
                verifier_config: gate.map(|_| verifier_config_address()),
                verifier_program: gate.map(|_| square_verifier::ID),
                escrow_authority: escrow_authority_address(),
                agent_reputation: reputation_address(&state.agent_record),
                validation_record: validation_address(job),
                rent_payer: state.rent_payer,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::FinalizePayment {}.data(),
        }
    }

    pub fn sync_ix(&self, agent_owner: &Pubkey, job: &Pubkey, agent_record: Pubkey) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::SyncAgentWallet {
                agent_owner: *agent_owner,
                job: *job,
                agent_record,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::SyncAgentWallet {}.data(),
        }
    }

    // ------------------------------------------------------------------ hazır durumlar

    /// Kayıtlı agent, temiz screening'li kurum ve agent cüzdanı, `Open` job: (kurum, agent, job).
    pub fn open_job(&mut self, policy: bool) -> (Institution, Agent, Pubkey) {
        let institution = self.institution(10 * AMOUNT);
        let agent = self.register_agent("research-agent");
        self.screen(&institution.key.pubkey(), ScreeningStatus::Clear);
        self.screen(&agent.wallet.pubkey(), ScreeningStatus::Clear);
        let policy = policy.then(|| self.policy(&institution.key, POLICY_ID));
        let ix = self.default_create_ix(&institution.key.pubkey(), &agent, policy);
        let key = institution.key.insecure_clone();
        self.h.send(&[ix], &[&key]).expect("create_job");
        let job = job_address(&institution.key.pubkey(), &SPEC);
        (institution, agent, job)
    }

    pub fn funded_job(&mut self) -> (Institution, Agent, Pubkey) {
        self.funded_job_with(false)
    }

    pub fn funded_job_with(&mut self, policy: bool) -> (Institution, Agent, Pubkey) {
        let (institution, agent, job) = self.open_job(policy);
        let ix = self.fund_job_ix(&institution, &job);
        let key = institution.key.insecure_clone();
        self.h.send(&[ix], &[&key]).expect("fund_job");
        (institution, agent, job)
    }

    pub fn accepted_job(&mut self) -> (Institution, Agent, Pubkey) {
        self.accepted_job_with(false)
    }

    pub fn accepted_job_with(&mut self, policy: bool) -> (Institution, Agent, Pubkey) {
        let (institution, agent, job) = self.funded_job_with(policy);
        let ix = self.accept_ix(&agent.wallet.pubkey(), &job, agent.record, SPEC);
        let wallet = agent.wallet.insecure_clone();
        self.h.send(&[ix], &[&wallet]).expect("accept_job");
        (institution, agent, job)
    }

    /// Teslim edilmiş policy'siz iş; challenge penceresi `CHALLENGE`.
    pub fn delivered_job(&mut self) -> (Institution, Agent, Pubkey) {
        self.delivered_job_with(false)
    }

    /// Teslim edilmiş iş; `policy` ise kurumun [`POLICY_ID`] politikasına bağlı.
    pub fn delivered_job_with(&mut self, policy: bool) -> (Institution, Agent, Pubkey) {
        let (institution, agent, job) = self.accepted_job_with(policy);
        let ix = self.submit_ix(
            &agent.wallet.pubkey(),
            &job,
            agent.record,
            "ipfs://delivery",
        );
        let wallet = agent.wallet.insecure_clone();
        self.h.send(&[ix], &[&wallet]).expect("submit_work");
        (institution, agent, job)
    }

    /// `payee`'ye ödenecek settlement; keeper'ın ve payee'nin token hesapları (yoksa açılır).
    pub fn settlement(
        &mut self,
        institution: &Institution,
        keeper: &Pubkey,
        payee: Pubkey,
    ) -> Settlement {
        let usdc = self.usdc;
        Settlement {
            payee,
            payee_token_account: token::create_ata(&mut self.h, &payee, &usdc),
            institution_token_account: institution.token_account,
            keeper_token_account: token::create_ata(&mut self.h, keeper, &usdc),
        }
    }

    pub fn finalize(&mut self, keeper: &Keypair, job: &Pubkey, settlement: Settlement) -> Outcome {
        let ix = self.finalize_ix(&keeper.pubkey(), job, settlement, None);
        self.h.send(&[ix], &[keeper])
    }
}
