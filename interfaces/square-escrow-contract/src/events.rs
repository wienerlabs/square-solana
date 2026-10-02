//! Events of the square_escrow interface contract.

use anchor_lang::prelude::*;

use crate::state::{DisputeResolution, ValidationOutcome};
use crate::EscrowParams;

#[event]
pub struct EscrowConfigUpdated {
    pub admin: Pubkey,
    pub settlement_mint: Pubkey,
    pub params: EscrowParams,
}

#[event]
pub struct ArbitratorsUpdated {
    pub arbitrators: Vec<Pubkey>,
    pub threshold: u8,
    pub arbitrator_set_version: u32,
}

#[event]
pub struct JobCreated {
    pub job: Pubkey,
    pub institution: Pubkey,
    pub agent_record: Pubkey,
    pub agent_wallet: Pubkey,
    pub policy: Option<Pubkey>,
    pub policy_version: u32,
    pub mint: Pubkey,
    pub amount: u64,
    pub spec_hash: [u8; 32],
    pub deadline: i64,
    pub challenge_period: u64,
}

/// DRAFT (M5).
#[event]
pub struct TravelRuleCommitted {
    pub job: Pubkey,
    pub commitment: [u8; 32],
}

#[event]
pub struct JobFunded {
    pub job: Pubkey,
    pub amount: u64,
}

#[event]
pub struct JobAccepted {
    pub job: Pubkey,
    pub agent_record: Pubkey,
    pub agent_wallet: Pubkey,
}

#[event]
pub struct WorkSubmitted {
    pub job: Pubkey,
    pub work_hash: [u8; 32],
    pub delivery_uri: String,
    pub challenge_end: i64,
}

#[event]
pub struct JobAgentWalletSynced {
    pub job: Pubkey,
    pub agent_wallet: Pubkey,
}

#[event]
pub struct ClaimListed {
    pub job: Pubkey,
    pub seller: Pubkey,
    pub price: u64,
    pub face_value: u64,
}

#[event]
pub struct ClaimBought {
    pub job: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
}

#[event]
pub struct ClaimCancelled {
    pub job: Pubkey,
}

#[event]
pub struct Finalized {
    pub job: Pubkey,
    pub keeper: Pubkey,
    pub keeper_fee: u64,
}

#[event]
pub struct ReleaseVerified {
    pub job: Pubkey,
    pub payee: Pubkey,
    pub net_amount: u64,
    pub release_proof: Option<Pubkey>,
}

#[event]
pub struct ReleaseRefused {
    pub job: Pubkey,
    pub refusal_code: u16,
    pub refunded_amount: u64,
    pub release_proof: Pubkey,
}

#[event]
pub struct DisputeRaised {
    pub job: Pubkey,
    pub challenger: Pubkey,
    pub bond: u64,
    pub reason_hash: [u8; 32],
    pub deadline: i64,
}

/// DRAFT (M5).
#[event]
pub struct MissingProofEscalated {
    pub job: Pubkey,
    pub agent_wallet: Pubkey,
}

#[event]
pub struct DisputeVote {
    pub job: Pubkey,
    pub arbitrator: Pubkey,
    pub resolution: DisputeResolution,
    pub approval_count: u8,
}

#[event]
pub struct DisputeDecided {
    pub job: Pubkey,
    pub resolution: DisputeResolution,
}

#[event]
pub struct DisputeResolved {
    pub job: Pubkey,
    pub resolution: DisputeResolution,
    pub agent_side_amount: u64,
    pub institution_refund: u64,
    pub bond_to_agent_side: u64,
    pub bond_returned: u64,
}

/// DRAFT (M5).
#[event]
pub struct DisputeLapsed {
    pub job: Pubkey,
    pub bond_refunded: u64,
}

#[event]
pub struct JobCancelled {
    pub job: Pubkey,
    pub refunded_amount: u64,
}

#[event]
pub struct ReputationRecorded {
    pub agent_record: Pubkey,
    pub job: Pubkey,
    pub jobs_completed: u64,
    pub jobs_failed: u64,
    pub jobs_disputed: u64,
    pub total_earned: u64,
}

#[event]
pub struct ValidationRecorded {
    pub job: Pubkey,
    pub agent_record: Pubkey,
    pub outcome: ValidationOutcome,
    pub refusal_code: u16,
}
