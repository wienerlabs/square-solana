//! Registry ve policy tarafı: agent kaydı ve cüzdanı, screening, kurum, politika. Hepsi programların kendi
//! talimatlarıyla kurulur.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_program_tests::token;
use square_program_tests::Outcome;
use square_registry::{AgentStatus, ScreeningStatus};

use super::{
    agent_record_address, institution_address, policy_address, registry_config_address,
    screening_address, Agent, Institution, PolicyAccounts, World, CEILING, COMMITMENT, LAMPORTS,
};

impl World {
    pub fn register_agent(&mut self, agent_id: &str) -> Agent {
        self.register_agent_with_wallet(agent_id, Keypair::new())
    }

    /// `register_agent`; kart işaretçisi `(uri, hash)` ya boş ya da dolu.
    pub fn register_agent_ix(
        &self,
        owner: &Pubkey,
        agent_id: &str,
        card: (&str, [u8; 32]),
        wallet: &Pubkey,
    ) -> Instruction {
        Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::RegisterAgent {
                payer: self.h.payer.pubkey(),
                owner: *owner,
                agent_record: agent_record_address(owner, agent_id),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_registry::instruction::RegisterAgent {
                agent_id: agent_id.to_string(),
                agent_card_uri: card.0.to_string(),
                agent_card_hash: card.1,
                wallet: *wallet,
            }
            .data(),
        }
    }

    pub fn register_agent_with_wallet(&mut self, agent_id: &str, wallet: Keypair) -> Agent {
        let owner = self.h.funded(LAMPORTS);
        let record = agent_record_address(&owner.pubkey(), agent_id);
        let ix = self.register_agent_ix(&owner.pubkey(), agent_id, ("", [0; 32]), &wallet.pubkey());
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

    /// Screener'ın `record_screening`'i.
    pub fn record_screening_ix(&self, wallet: &Pubkey, status: ScreeningStatus) -> Instruction {
        Instruction {
            program_id: square_registry::ID,
            accounts: square_registry::accounts::RecordScreening {
                payer: self.h.payer.pubkey(),
                screener_authority: self.screener.pubkey(),
                config: registry_config_address(),
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
        }
    }

    pub fn screen(&mut self, wallet: &Pubkey, status: ScreeningStatus) {
        let ix = self.record_screening_ix(wallet, status);
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
        let init = self.init_institution_ix(&owner.pubkey(), "Research procurement");
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

    pub fn init_institution_ix(&self, owner: &Pubkey, name: &str) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::InitInstitution {
                payer: self.h.payer.pubkey(),
                authority: *owner,
                institution: institution_address(owner),
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_policy::instruction::InitInstitution {
                name: name.to_string(),
            }
            .data(),
        }
    }

    pub fn update_policy_ix(
        &self,
        authority: &Pubkey,
        policy: PolicyAccounts,
        commitment: [u8; 32],
        daily_ceiling: u64,
    ) -> Instruction {
        Instruction {
            program_id: square_policy::ID,
            accounts: square_policy::accounts::UpdatePolicy {
                authority: *authority,
                institution: policy.institution,
                policy: policy.policy,
            }
            .to_account_metas(None),
            data: square_policy::instruction::UpdatePolicy {
                commitment,
                daily_ceiling,
            }
            .data(),
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
}
