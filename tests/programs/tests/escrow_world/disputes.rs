//! Uyuşmazlık (BC-32, BC-33): M-of-N arbitrator paneli, `raise_dispute`, `resolve_dispute`,
//! `execute_resolution`, `lapse_dispute`, `escalate_missing_proof` ve `update_arbitrators`.

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use solana_keypair::Keypair;
use solana_signer::Signer;
use square_common::seeds::{BOND_SEED, RELEASE_PROOF_SEED};
use square_escrow::state::DisputeResolution;
use square_program_tests::token::TOKEN_PROGRAM_ID;
use square_program_tests::Outcome;

use super::{
    claim_address, config_address, escrow_authority_address, reputation_address, screening_address,
    validation_address, vault_address, verifier_config_address, GateAccounts, Institution,
    Settlement, World, AMOUNT,
};

/// `params()`'a göre en düşük bond: `max(AMOUNT × 5%, 1 USDC)`.
pub const MIN_BOND: u64 = AMOUNT / 20;
pub const REASON: [u8; 32] = [0xd1; 32];

pub fn bond_address(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[BOND_SEED, job.as_ref()], &square_escrow::ID).0
}

pub fn release_proof_pda(job: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[RELEASE_PROOF_SEED, job.as_ref()], &square_verifier::ID).0
}

/// Escrow config'inin arbitrator paneli: imzalayabilen anahtarlar ve eşik.
pub struct Panel {
    pub arbitrators: Vec<Keypair>,
    pub threshold: u8,
}

impl Panel {
    pub fn new(n: usize, threshold: u8) -> Self {
        Self {
            arbitrators: (0..n).map(|_| Keypair::new()).collect(),
            threshold,
        }
    }

    pub fn keys(&self) -> Vec<Pubkey> {
        self.arbitrators.iter().map(Signer::pubkey).collect()
    }
}

impl World {
    /// Job'un bond vault'u (bond'lu dispute açıkken var; escalation'da ve kapandıktan sonra yok).
    pub fn bond_vault(&self, job: &Pubkey) -> Option<Pubkey> {
        let address = bond_address(job);
        self.h.raw_account(&address).map(|_| address)
    }

    pub fn raise_dispute_ix(
        &self,
        institution: &Institution,
        job: &Pubkey,
        bond: u64,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::RaiseDispute {
                payer: self.h.payer.pubkey(),
                institution: institution.key.pubkey(),
                config: config_address(),
                job: *job,
                bond_vault: bond_address(job),
                institution_token_account: institution.token_account,
                mint: self.usdc,
                token_program: TOKEN_PROGRAM_ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::RaiseDispute {
                reason_hash: REASON,
                bond,
            }
            .data(),
        }
    }

    pub fn raise_dispute(&mut self, institution: &Institution, job: &Pubkey, bond: u64) -> Outcome {
        let ix = self.raise_dispute_ix(institution, job, bond);
        let key = institution.key.insecure_clone();
        self.h.send(&[ix], &[&key])
    }

    pub fn vote_ix(
        &self,
        arbitrator: &Pubkey,
        job: &Pubkey,
        resolution: DisputeResolution,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::ResolveDispute {
                arbitrator: *arbitrator,
                config: config_address(),
                job: *job,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::ResolveDispute { resolution }.data(),
        }
    }

    pub fn vote(
        &mut self,
        arbitrator: &Keypair,
        job: &Pubkey,
        resolution: DisputeResolution,
    ) -> Outcome {
        let ix = self.vote_ix(&arbitrator.pubkey(), job, resolution);
        self.h.send(&[ix], &[arbitrator])
    }

    /// Panelin ilk `threshold` üyesi aynı kararı verir.
    pub fn decide(&mut self, job: &Pubkey, resolution: DisputeResolution) {
        let voters: Vec<Keypair> = self
            .panel
            .arbitrators
            .iter()
            .take(usize::from(self.panel.threshold))
            .map(Keypair::insecure_clone)
            .collect();
        for arbitrator in &voters {
            self.vote(arbitrator, job, resolution)
                .expect("resolve_dispute");
        }
    }

    /// `execute_resolution`; bond vault'u job'un bond'u varsa geçer.
    pub fn execute_ix(
        &self,
        payer: &Pubkey,
        job: &Pubkey,
        settlement: Settlement,
        gate: Option<GateAccounts>,
    ) -> Instruction {
        let state = self.job(job);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::ExecuteResolution {
                payer: *payer,
                config: config_address(),
                job: *job,
                vault: vault_address(job),
                bond_vault: self.bond_vault(job),
                claim_listing: claim_address(job),
                payee_token_account: settlement.payee_token_account,
                institution_token_account: settlement.institution_token_account,
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
            data: square_escrow::instruction::ExecuteResolution {}.data(),
        }
    }

    pub fn execute(&mut self, payer: &Keypair, job: &Pubkey, settlement: Settlement) -> Outcome {
        let ix = self.execute_ix(&payer.pubkey(), job, settlement, None);
        self.h.send(&[ix], &[payer])
    }

    pub fn lapse_ix(
        &self,
        caller: &Pubkey,
        job: &Pubkey,
        institution_token_account: Pubkey,
    ) -> Instruction {
        let state = self.job(job);
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::LapseDispute {
                caller: *caller,
                config: config_address(),
                job: *job,
                bond_vault: self.bond_vault(job),
                institution_token_account,
                mint: self.usdc,
                rent_payer: state.rent_payer,
                token_program: TOKEN_PROGRAM_ID,
            }
            .to_account_metas(None),
            data: square_escrow::instruction::LapseDispute {}.data(),
        }
    }

    pub fn lapse(
        &mut self,
        caller: &Keypair,
        job: &Pubkey,
        institution_token_account: Pubkey,
    ) -> Outcome {
        let ix = self.lapse_ix(&caller.pubkey(), job, institution_token_account);
        self.h.send(&[ix], &[caller])
    }

    pub fn escalate_ix(&self, agent: &Pubkey, job: &Pubkey) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::EscalateMissingProof {
                agent: *agent,
                config: config_address(),
                job: *job,
                release_proof: release_proof_pda(job),
            }
            .to_account_metas(None),
            data: square_escrow::instruction::EscalateMissingProof {}.data(),
        }
    }

    pub fn escalate(&mut self, agent: &Keypair, job: &Pubkey) -> Outcome {
        let ix = self.escalate_ix(&agent.pubkey(), job);
        self.h.send(&[ix], &[agent])
    }

    pub fn update_arbitrators_ix(
        &self,
        admin: &Pubkey,
        arbitrators: Vec<Pubkey>,
        threshold: u8,
    ) -> Instruction {
        Instruction {
            program_id: square_escrow::ID,
            accounts: square_escrow::accounts::UpdateConfig {
                admin: *admin,
                config: config_address(),
            }
            .to_account_metas(None),
            data: square_escrow::instruction::UpdateArbitrators {
                arbitrators,
                threshold,
            }
            .data(),
        }
    }

    pub fn update_arbitrators(&mut self, arbitrators: Vec<Pubkey>, threshold: u8) -> Outcome {
        let ix = self.update_arbitrators_ix(&self.admin.pubkey(), arbitrators, threshold);
        let admin = self.admin.insecure_clone();
        self.h.send(&[ix], &[&admin])
    }
}
