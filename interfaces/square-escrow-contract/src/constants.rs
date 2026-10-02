//! Constants and PDA seeds of the square_escrow interface contract.

use anchor_lang::prelude::*;

/// Upper bound of the arbitrator set (M-of-N, BC-32). The approval bitmask is a `u8`.
pub const MAX_ARBITRATORS: usize = 7;
/// Covenant value; keeps the `try_accounts` frame under the 4 KB SBF stack.
pub const DELIVERY_URI_MAX_LEN: usize = 128;
/// Maximum depth of the approved-buyer Merkle proof (2^16 buyers).
pub const MAX_MERKLE_PROOF_LEN: usize = 16;
pub const BPS_DENOMINATOR: u64 = 10_000;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const JOB_SEED: &[u8] = b"job";
#[constant]
pub const VAULT_SEED: &[u8] = b"escrow_token";
#[constant]
pub const BOND_SEED: &[u8] = b"bond";
#[constant]
pub const CLAIM_SEED: &[u8] = b"claim";
#[constant]
pub const REPUTATION_SEED: &[u8] = b"reputation";
#[constant]
pub const VALIDATION_SEED: &[u8] = b"validation";
#[constant]
pub const ESCROW_AUTHORITY_SEED: &[u8] = b"escrow_authority";

// Seeds of accounts owned by other Square programs (account-read; re-derived or `seeds::program`).
/// square_registry `AgentRecord` ["agent", creator, agent_id].
pub const AGENT_SEED: &[u8] = b"agent";
/// square_registry `ScreeningRecord` ["screening", wallet].
pub const SCREENING_SEED: &[u8] = b"screening";
/// square_policy `Institution` ["institution", owner_key].
pub const INSTITUTION_SEED: &[u8] = b"institution";
/// square_policy `Policy` ["policy", institution, policy_id].
pub const POLICY_SEED: &[u8] = b"policy";
/// square_verifier `VerifierConfig` ["verifier_config"].
pub const VERIFIER_CONFIG_SEED: &[u8] = b"verifier_config";
/// square_verifier `OperatorState` ["operator_state", institution].
pub const OPERATOR_STATE_SEED: &[u8] = b"operator_state";
/// square_verifier `ReleaseProof` ["release_proof", job].
pub const RELEASE_PROOF_SEED: &[u8] = b"release_proof";
