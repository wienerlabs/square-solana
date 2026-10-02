//! square_escrow — interface contract v0.1.0 (BC-44).
//!
//! Bodiless stub: every instruction returns `EscrowError::NotImplemented`. The real program lives in
//! `programs/square-escrow` (BC-04 migration from Covenant, then BC-22..BC-27, BC-32..BC-36). Covenant's
//! seeds (`config`, `job`, `escrow_token`, `bond`, `claim`, `reputation`) are kept.
//!
//! State machine:
//!   Open -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
//!   Delivered -(finalize_payment)-> Released | Refunded          (proof gate decides for policy jobs)
//!   Delivered -(raise_dispute | escalate_missing_proof*)-> Disputed
//!   Disputed -(resolve_dispute votes reach M)-> Resolved -(execute_resolution)-> Released | Refunded
//!   Disputed -(lapse_dispute*)-> Delivered                        (* = DRAFT M5)
//!   Open | Funded | Accepted(after deadline) -(cancel_job)-> Cancelled
//!
//! Cross-program access: registry / policy / verifier accounts are read (owner + seed checks, no CPI).
//! The single CPI is `square_verifier::record_release`, signed by the ["escrow_authority"] PDA.
#![allow(unused_variables, deprecated, clippy::too_many_arguments)]

use anchor_lang::prelude::*;

// Source program address (Covenant). New Square program IDs are assigned in BC-09.
declare_id!("5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT");

pub mod constants;
pub mod contexts;
pub mod errors;
pub mod events;
pub mod state;

pub use constants::*;
pub use contexts::*;
pub use errors::*;
pub use events::*;
pub use state::*;

#[program]
pub mod square_escrow_contract {
    use super::*;

    // ---------------------------------------------------------------- config

    /// Creates the singleton config. Only the program upgrade authority (Squads vault) can call it.
    /// `settlement_mint` is the only job mint (USDC); `linked` pins the registry / policy / verifier
    /// program IDs used for account-read owner checks.
    pub fn init_config(
        ctx: Context<InitConfig>,
        settlement_mint: Pubkey,
        arbitrators: Vec<Pubkey>,
        threshold: u8,
        params: EscrowParams,
        linked: LinkedPrograms,
    ) -> Result<()> {
        not_implemented()
    }

    /// Replaces the arbitrator set (N <= 7, 2 <= M <= N) and bumps `arbitrator_set_version`.
    /// DRAFT (M5, BC-32): rule for disputes that are active while the set changes.
    pub fn update_arbitrators(
        ctx: Context<UpdateConfig>,
        arbitrators: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        not_implemented()
    }

    /// Updates challenge bounds, bond, keeper fee and the M5 draft parameters.
    pub fn update_params(ctx: Context<UpdateConfig>, params: EscrowParams) -> Result<()> {
        not_implemented()
    }

    // ---------------------------------------------------------------- job lifecycle (steps 3-4)

    /// Flow step 3a: the institution opens a job for an active registered agent and creates its empty
    /// vault. With the optional `policy` account the job is proof-gated and snapshots the policy's
    /// commitment, daily ceiling and version. Funds move in `fund_job`.
    pub fn create_job(
        ctx: Context<CreateJob>,
        spec_hash: [u8; 32],
        amount: u64,
        deadline: i64,
        challenge_period: u64,
    ) -> Result<()> {
        not_implemented()
    }

    /// DRAFT (M5, BC-34): binds a salted Travel Rule commitment (no PII on chain). Required before
    /// `fund_job` when `amount >= params.travel_rule_threshold` (threshold 0 = disabled).
    pub fn commit_travel_rule(ctx: Context<InstitutionJob>, commitment: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    /// Flow step 3b: locks `amount` in the vault. Both parties need a fresh, clear screening record.
    /// CCTP (DRAFT M6, BC-36): runs in the same tx after the CCTP `receive_message` that mints USDC to
    /// the institution's token account; no separate instruction is planned.
    pub fn fund_job(ctx: Context<FundJob>) -> Result<()> {
        not_implemented()
    }

    /// The job's agent wallet accepts a funded job; the agent record must be Active. `spec_hash`
    /// guards against a swapped spec.
    pub fn accept_job(ctx: Context<AgentJob>, spec_hash: [u8; 32]) -> Result<()> {
        not_implemented()
    }

    /// Flow step 4: delivery; the challenge window opens (`challenge_end = now + challenge_period`).
    pub fn submit_work(
        ctx: Context<AgentJob>,
        work_hash: [u8; 32],
        delivery_uri: String,
    ) -> Result<()> {
        not_implemented()
    }

    /// The agent record owner re-points an unsettled job to the record's current wallet (after a
    /// wallet rotation with registry `update_agent`). A sold receivable keeps paying the buyer.
    pub fn sync_agent_wallet(ctx: Context<SyncAgentWallet>) -> Result<()> {
        not_implemented()
    }

    // ---------------------------------------------------------------- claim market (step 5)

    /// The agent lists its receivable on a delivered job below face value.
    pub fn list_claim(ctx: Context<ListClaim>, price: u64) -> Result<()> {
        not_implemented()
    }

    /// A screened buyer on the institution's approved list buys the receivable. `price` must equal
    /// the listing price (front-running guard). Leaf = sha256(buyer || leaf_salt), checked against the
    /// current `policy.buyer_root`; jobs without a policy or with an all-zero root are unrestricted.
    pub fn buy_claim(
        ctx: Context<BuyClaim>,
        price: u64,
        leaf_salt: [u8; 32],
        merkle_proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        not_implemented()
    }

    /// The seller withdraws an unsold listing; the account is closed and its rent returned.
    pub fn cancel_claim(ctx: Context<CancelClaim>) -> Result<()> {
        not_implemented()
    }

    // ---------------------------------------------------------------- settlement (steps 6-8)

    /// Flow steps 6-8, permissionless crank. After `challenge_end` with no dispute:
    /// - no policy: pay the payee (claim buyer if sold, else agent wallet) `amount - keeper fee`;
    /// - policy: read `ReleaseProof` ["release_proof", job] owned by square_verifier. Missing ->
    ///   `ProofRequired` (escrow waits). `Compliant` with matching payee / net / mint / daily counter
    ///   -> pay the payee, CPI `record_release`, `ReleaseVerified`. `Refused` -> refund the net to the
    ///   institution, `ReleaseRefused` with the reason code.
    ///
    /// The keeper fee is paid in every branch. Reputation goes to the agent record (not the buyer); a
    /// `ValidationRecord` is written; the vault is closed and its rent returned to `job.rent_payer`.
    pub fn finalize_payment(ctx: Context<FinalizePayment>) -> Result<()> {
        not_implemented()
    }

    // ---------------------------------------------------------------- disputes

    /// The institution disputes a delivery inside the challenge window with a bond
    /// `>= max(amount * min_bond_bps / 10_000, min_bond_absolute)`. One dispute per job.
    pub fn raise_dispute(
        ctx: Context<RaiseDispute>,
        reason_hash: [u8; 32],
        bond: u64,
    ) -> Result<()> {
        not_implemented()
    }

    /// DRAFT (M5, BC-24/BC-33): the agent's recourse when a policy job has no bound release proof
    /// `proof_timeout_secs` after `challenge_end`: opens a dispute without bond.
    pub fn escalate_missing_proof(ctx: Context<EscalateMissingProof>) -> Result<()> {
        not_implemented()
    }

    /// One arbitrator vote. The first vote sets the pending resolution, later votes must match it;
    /// reaching the threshold moves the job to `Resolved` (`DisputeDecided`). No funds move here.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        resolution: DisputeResolution,
    ) -> Result<()> {
        not_implemented()
    }

    /// Permissionless: pays out a `Resolved` dispute. The agent-side amount goes through the same
    /// payee resolution and proof gate as `finalize_payment` (no keeper fee); the bond is slashed to
    /// the agent side (FavorAgent) or returned to the institution. Closes the vaults.
    pub fn execute_resolution(ctx: Context<ExecuteResolution>) -> Result<()> {
        not_implemented()
    }

    /// DRAFT (M5, BC-33): permissionless after `dispute.deadline` without a decision. Returns the bond
    /// and drops the dispute: the job goes back to `Delivered` and settles through `finalize_payment`.
    pub fn lapse_dispute(ctx: Context<LapseDispute>) -> Result<()> {
        not_implemented()
    }

    // ---------------------------------------------------------------- cancellation

    /// The institution cancels an Open / Funded job, or an Accepted job after `deadline`; the vault
    /// balance is refunded and the vault closed (rent to `job.rent_payer`).
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        not_implemented()
    }
}

fn not_implemented() -> Result<()> {
    err!(EscrowError::NotImplemented)
}

// ------------------------------------------------------------------ instruction argument types

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct EscrowParams {
    pub min_challenge_period: u64,
    pub max_challenge_period: u64,
    pub min_bond_bps: u16,
    pub min_bond_absolute: u64,
    /// Share of the escrowed amount paid to the `finalize_payment` caller (BC-23).
    pub keeper_fee_bps: u16,
    /// DRAFT (M5, BC-24): `escalate_missing_proof` allowed after `challenge_end + proof_timeout_secs`.
    pub proof_timeout_secs: i64,
    /// DRAFT (M5, BC-33): `dispute.deadline = raised_at + dispute_timeout_secs`.
    pub dispute_timeout_secs: i64,
    /// DRAFT (M5, BC-34): jobs at or above this amount need a Travel Rule commitment; 0 = disabled.
    pub travel_rule_threshold: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct LinkedPrograms {
    pub registry_program: Pubkey,
    pub policy_program: Pubkey,
    pub verifier_program: Pubkey,
}
