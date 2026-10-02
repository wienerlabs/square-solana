//! square_verifier — interface contract v0.1.0 (BC-44).
//!
//! Bodiless stub: every instruction returns `VerifierError::NotImplemented`. The real program lives in
//! `programs/square-verifier` (BC-05 migration from Aperture verifier, BC-21 release proof binding,
//! BC-37 MPP). Release model (Arc step 7): the institution binds a Groth16 proof to a job *before* the
//! release; escrow reads the resulting `ReleaseProof` account (account-read, no CPI) at release time.
//! The only cross-program call is escrow → `record_release` (CPI) to advance the daily spend counter,
//! because escrow cannot write a verifier-owned account.
//!
//! Split of checks: the verifier checks the proof against the job's policy snapshot and binds payee
//! and mint (from `Job` / `ClaimListing`); escrow checks the bound net amount, payee, mint and the
//! daily counter again at release and rejects a stale proof.
#![allow(unused_variables, deprecated, clippy::too_many_arguments)]

use anchor_lang::prelude::*;

// Source program address (Aperture verifier). New Square program IDs are assigned in BC-09.
declare_id!("AzKirEv7h5PstLNYNqLj7fCXU9EFA6nSnuoed3QkmUfU");

/// Public inputs of the payment-compliance circuit (Aperture: 10). Finalized in BC-19.
pub const PUBLIC_INPUTS: usize = 10;

#[constant]
pub const VERIFIER_CONFIG_SEED: &[u8] = b"verifier_config";
#[constant]
pub const OPERATOR_STATE_SEED: &[u8] = b"operator_state";
#[constant]
pub const RELEASE_PROOF_SEED: &[u8] = b"release_proof";

// Seeds of accounts owned by other Square programs (re-derived on account-read).
/// square_escrow CPI signer PDA ["escrow_authority"] (derived under `VerifierConfig.escrow_program`).
pub const ESCROW_AUTHORITY_SEED: &[u8] = b"escrow_authority";
/// square_escrow `Job` ["job", institution_wallet, spec_hash].
pub const ESCROW_JOB_SEED: &[u8] = b"job";
/// square_escrow `ClaimListing` ["claim", job].
pub const ESCROW_CLAIM_SEED: &[u8] = b"claim";
/// square_policy `Institution` ["institution", owner_key].
pub const POLICY_INSTITUTION_SEED: &[u8] = b"institution";
/// square_policy `Policy` ["policy", institution, policy_id].
pub const POLICY_ACCOUNT_SEED: &[u8] = b"policy";

#[program]
pub mod square_verifier_contract {
    use super::*;

    /// Creates the singleton verifier config. Only the program upgrade authority (Squads vault) can
    /// call it. `escrow_program` / `policy_program` pin the owners checked on account-read.
    pub fn init_verifier_config(
        ctx: Context<InitVerifierConfig>,
        escrow_program: Pubkey,
        policy_program: Pubkey,
        mpp_authority: Pubkey,
    ) -> Result<()> {
        not_implemented()
    }

    /// Flow step 7: verifies a Groth16 proof (alt_bn128) against the job's policy snapshot
    /// (`Job.policy_commitment`, `Job.policy_daily_ceiling`) and binds it to the job as the chain will
    /// pay it now: payee (claim buyer if the receivable was sold), net amount, mint, the institution's
    /// daily counter and the clock. Writes `ReleaseProof` with a verdict; a refusing proof records
    /// `Refused` + reason code. Can be re-bound until escrow consumes it.
    pub fn set_compliance_proof(
        ctx: Context<SetComplianceProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PUBLIC_INPUTS],
    ) -> Result<()> {
        not_implemented()
    }

    /// CPI-only (escrow, signed by its `escrow_authority` PDA): marks the release proof consumed and
    /// advances `OperatorState.daily_spent` (UTC-day rollover) by the released net amount.
    pub fn record_release(ctx: Context<RecordRelease>) -> Result<()> {
        not_implemented()
    }

    /// DRAFT (M6, BC-37): Stripe MPP path — checks the compliance-api ed25519 attestation from the
    /// preceding Ed25519 precompile instruction and records the payment proof.
    pub fn verify_mpp_payment_proof(
        ctx: Context<VerifyMppPaymentProof>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        public_inputs: [[u8; 32]; PUBLIC_INPUTS],
    ) -> Result<()> {
        not_implemented()
    }

    /// DRAFT (M6, BC-37): rotates the MPP attestation authority (replaces Aperture's compile-time key).
    pub fn update_mpp_authority(
        ctx: Context<UpdateVerifierConfig>,
        mpp_authority: Pubkey,
    ) -> Result<()> {
        not_implemented()
    }
}

fn not_implemented() -> Result<()> {
    err!(VerifierError::NotImplemented)
}

// ------------------------------------------------------------------ accounts (contexts)

#[derive(Accounts)]
pub struct InitVerifierConfig<'info> {
    /// Must be the program upgrade authority.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + VerifierConfig::INIT_SPACE,
        seeds = [VERIFIER_CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, VerifierConfig>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, crate::program::SquareVerifierContract>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVerifierConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [VERIFIER_CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, VerifierConfig>,
}

#[derive(Accounts)]
pub struct SetComplianceProof<'info> {
    /// Pays rent and fees; separate from the role signer (fee payer / sponsored transactions).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The institution's current authority (key, or its Squads vault once bound).
    pub authority: Signer<'info>,
    #[account(seeds = [VERIFIER_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,
    /// CHECK: square_policy `Institution` (owner = `config.policy_program`, seeds re-derived).
    pub institution: UncheckedAccount<'info>,
    /// CHECK: square_policy `Policy` of the job; `policy.institution == institution`.
    pub policy: UncheckedAccount<'info>,
    /// CHECK: square_escrow `Job` (owner = `config.escrow_program`); Delivered or Disputed,
    /// `job.policy == policy`; supplies the policy snapshot, mint and default payee.
    pub job: UncheckedAccount<'info>,
    /// CHECK: square_escrow `ClaimListing`; may be uninitialized. `Bought` makes the buyer the payee.
    #[account(
        seeds = [ESCROW_CLAIM_SEED, job.key().as_ref()],
        bump,
        seeds::program = config.escrow_program.key()
    )]
    pub claim_listing: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [OPERATOR_STATE_SEED, institution.key().as_ref()],
        bump
    )]
    pub operator_state: Account<'info, OperatorState>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + ReleaseProof::INIT_SPACE,
        seeds = [RELEASE_PROOF_SEED, job.key().as_ref()],
        bump
    )]
    pub release_proof: Account<'info, ReleaseProof>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RecordRelease<'info> {
    /// PDA ["escrow_authority"] of `config.escrow_program`; signs via `invoke_signed`.
    pub escrow_authority: Signer<'info>,
    #[account(seeds = [VERIFIER_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,
    #[account(
        mut,
        seeds = [RELEASE_PROOF_SEED, release_proof.job.as_ref()],
        bump = release_proof.bump
    )]
    pub release_proof: Account<'info, ReleaseProof>,
    #[account(
        mut,
        seeds = [OPERATOR_STATE_SEED, release_proof.institution.as_ref()],
        bump = operator_state.bump
    )]
    pub operator_state: Account<'info, OperatorState>,
}

#[derive(Accounts)]
pub struct VerifyMppPaymentProof<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [VERIFIER_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, VerifierConfig>,
    /// CHECK: square_policy `Institution` (account-read).
    pub institution: UncheckedAccount<'info>,
    /// CHECK: square_policy `Policy` (account-read).
    pub policy: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + OperatorState::INIT_SPACE,
        seeds = [OPERATOR_STATE_SEED, institution.key().as_ref()],
        bump
    )]
    pub operator_state: Account<'info, OperatorState>,
    /// CHECK: Sysvar Instructions (address-checked) to read the preceding Ed25519 verify instruction.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ------------------------------------------------------------------ state

/// Singleton. seeds = ["verifier_config"]
#[account]
#[derive(InitSpace)]
pub struct VerifierConfig {
    pub admin: Pubkey,
    /// Owner of `Job` / `ClaimListing`; its ["escrow_authority"] PDA may call `record_release`.
    pub escrow_program: Pubkey,
    /// Owner of `Institution` / `Policy` accounts read by the verifier.
    pub policy_program: Pubkey,
    /// DRAFT (M6): ed25519 key of the compliance-api MPP attestations.
    pub mpp_authority: Pubkey,
    /// Version of the embedded verifying key (bumped after the phase-2 ceremony, BC-38).
    pub vk_version: u16,
    pub bump: u8,
}

/// seeds = ["operator_state", institution] (institution = square_policy `Institution` PDA)
#[account]
#[derive(InitSpace)]
pub struct OperatorState {
    pub institution: Pubkey,
    /// Released amount in the current UTC day (settlement-mint atomic units); circuit public input.
    pub daily_spent: u64,
    /// UTC midnight that starts the current window.
    pub day_start_unix: i64,
    pub total_lifetime_payments: u64,
    pub bump: u8,
}

/// seeds = ["release_proof", job]
#[account]
#[derive(InitSpace)]
pub struct ReleaseProof {
    pub job: Pubkey,
    /// square_policy `Institution` PDA (key of the `OperatorState` it advances).
    pub institution: Pubkey,
    pub policy: Pubkey,
    /// Address the proof is bound to: the agent wallet, or the claim buyer if the receivable was sold.
    pub payee: Pubkey,
    /// Amount the payee receives; escrow compares it with its own net at release.
    pub net_amount: u64,
    pub mint: Pubkey,
    /// `OperatorState.daily_spent` the proof was built against; a different value at release = stale.
    pub daily_spent_before: u64,
    pub proof_timestamp: i64,
    pub verdict: ReleaseVerdict,
    /// Policy rule that refused the release (0 when compliant). Codes defined with the circuit (BC-19).
    pub refusal_code: u16,
    pub consumed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ReleaseVerdict {
    Compliant,
    Refused,
}

// ------------------------------------------------------------------ events

#[event]
pub struct VerifierConfigUpdated {
    pub admin: Pubkey,
    pub escrow_program: Pubkey,
    pub policy_program: Pubkey,
    pub mpp_authority: Pubkey,
    pub vk_version: u16,
}

#[event]
pub struct ComplianceProofSet {
    pub job: Pubkey,
    pub policy: Pubkey,
    pub verdict: ReleaseVerdict,
    pub refusal_code: u16,
    pub payee: Pubkey,
    pub net_amount: u64,
    pub mint: Pubkey,
    pub daily_spent_before: u64,
}

#[event]
pub struct ReleaseRecorded {
    pub job: Pubkey,
    pub institution: Pubkey,
    pub net_amount: u64,
    pub daily_spent: u64,
    pub day_start_unix: i64,
}

/// DRAFT (M6).
#[event]
pub struct MppPaymentVerified {
    pub institution: Pubkey,
    pub policy: Pubkey,
    pub stripe_receipt_hash: [u8; 32],
    pub amount: u64,
}

// ------------------------------------------------------------------ errors

/// Codes start at 6000 in every Square program; clients map errors by (program id, code).
/// (`#[error_code(offset)]` is not used: Anchor 0.31 IDLs ignore it.)
#[error_code]
pub enum VerifierError {
    #[msg("Groth16 proof verification failed")]
    InvalidProof,
    #[msg("Job has no policy or references a different policy")]
    PolicyMismatch,
    #[msg("Proof commitment or ceiling does not match the job's policy snapshot")]
    SnapshotMismatch,
    #[msg("Proof payee does not match the address the escrow will pay")]
    PayeeMismatch,
    #[msg("Proof mint does not match the job mint")]
    MintMismatch,
    #[msg("Proof was built against an outdated daily counter or clock")]
    StaleProof,
    #[msg("Release proof already consumed")]
    ProofAlreadyConsumed,
    #[msg("Signer is not authorized for this operation")]
    Unauthorized,
    #[msg("Account owner or seeds do not match the linked program")]
    InvalidLinkedAccount,
    #[msg("Job is not in a state that accepts a release proof")]
    InvalidJobState,
    #[msg("MPP attestation missing or signed by an unexpected key")]
    InvalidMppAttestation,
    /// Stub-only; always the last variant so removing it never shifts the contract error codes.
    #[msg("Interface contract stub: not implemented")]
    NotImplemented,
}
