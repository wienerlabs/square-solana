//! Square escrow programı (program arayüzü §6, §10.4). Covenant'ın escrow'undan geçmişiyle taşındı (BC-04)
//! ve sözleşmeye göre yeniden yazılıyor. BC-22: config, iş yaşam döngüsü ve agent bağlama. BC-23, BC-24,
//! BC-26: permissionless finalize, keeper ücreti, ispat kapısı, itibar ve validation kaydı. BC-25: alacak
//! piyasası ve alıcı uygunluğu. BC-34: Travel Rule commitment'ı. BC-32: M-of-N arbitration. BC-33:
//! dispute zaman aşımı ve ispatsız bekleme başvurusu (ADR 0016).
//!
//!   Open (-(commit_travel_rule)) -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
//!   Delivered -(finalize_payment)-> Released | Refunded
//!   Delivered -(raise_dispute | escalate_missing_proof)-> Disputed -(resolve_dispute × M)-> Resolved
//!   Resolved -(execute_resolution)-> Released | Refunded
//!   Disputed (deadline sonrası) -(lapse_dispute)-> Delivered
//!   Open | Funded | Accepted (deadline sonrası) -(cancel_job)-> Cancelled
//!
//!   Alacak (Delivered iş): -(list_claim)-> Listed -(buy_claim)-> Bought
//!   Listed -(cancel_claim)-> kapanır; finalize: Listed | Bought -> Settled (ödeme) | Defaulted (iade)
//!
//! İş bir registry `AgentRecord`'una ve opsiyonel bir policy'ye bağlanır; policy'nin commitment'ı, günlük
//! tavanı ve sürümü job'a kopyalanır. Diğer programların hesapları CPI'sız okunur (`linked`,
//! `release_gate`); tek CPI verifier'ın `record_release`'idir.
use anchor_lang::prelude::*;

pub mod config_rules;
pub mod dispute;
pub mod errors;
pub mod instructions;
pub mod linked;
pub mod release_gate;
pub mod settlement;
pub mod state;

use instructions::*;
pub use state::{DisputeResolution, EscrowParams, LinkedPrograms, ValidationOutcome};

// Kaynak programın (Covenant) adresi; Square'in program kimlikleri BC-09'da.
declare_id!("6yBTEVbizMVCWAp4c3jx6Xdsay3CiUmrJmTswY7QRWaX");

square_common::square_escrow_events!();

// PDA seed'leri IDL'de de yayımlanır; değerler sözleşmeden (square-common).
#[constant]
pub const CONFIG_SEED: &[u8] = square_common::seeds::CONFIG_SEED;
#[constant]
pub const JOB_SEED: &[u8] = square_common::seeds::JOB_SEED;
#[constant]
pub const VAULT_SEED: &[u8] = square_common::seeds::VAULT_SEED;
#[constant]
pub const BOND_SEED: &[u8] = square_common::seeds::BOND_SEED;
#[constant]
pub const CLAIM_SEED: &[u8] = square_common::seeds::CLAIM_SEED;
#[constant]
pub const REPUTATION_SEED: &[u8] = square_common::seeds::REPUTATION_SEED;
#[constant]
pub const VALIDATION_SEED: &[u8] = square_common::seeds::VALIDATION_SEED;
#[constant]
pub const ESCROW_AUTHORITY_SEED: &[u8] = square_common::seeds::ESCROW_AUTHORITY_SEED;

#[program]
pub mod square_escrow {
    use super::*;

    /// The job's agent wallet accepts a funded job; the agent record must be Active. `spec_hash`
    /// guards against a swapped spec.
    pub fn accept_job(ctx: Context<AgentJob>, spec_hash: [u8; 32]) -> Result<()> {
        instructions::accept_job::handler(ctx, spec_hash)
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
        instructions::buy_claim::handler(ctx, price, leaf_salt, merkle_proof)
    }

    /// The seller withdraws an unsold listing; the account is closed and its rent returned.
    pub fn cancel_claim(ctx: Context<CancelClaim>) -> Result<()> {
        instructions::cancel_claim::handler(ctx)
    }

    /// The institution cancels an Open / Funded job, or an Accepted job after `deadline`; the vault
    /// balance is refunded and the vault closed (rent to `job.rent_payer`).
    pub fn cancel_job(ctx: Context<CancelJob>) -> Result<()> {
        instructions::cancel_job::handler(ctx)
    }

    /// Binds a salted Travel Rule commitment to an Open job (no PII on chain, ADR 0015). It can be
    /// replaced until `fund_job`, which requires it when `amount >= params.travel_rule_threshold`
    /// (threshold 0 = disabled).
    pub fn commit_travel_rule(ctx: Context<InstitutionJob>, commitment: [u8; 32]) -> Result<()> {
        instructions::commit_travel_rule::handler(ctx, commitment)
    }

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
        instructions::create_job::handler(ctx, spec_hash, amount, deadline, challenge_period)
    }

    /// The agent's recourse when a policy job's release cannot settle: `proof_timeout_secs` after
    /// `challenge_end` (or after a lapsed dispute closed) with no bound proof, a temporary refusal or
    /// a proof evaluated on another UTC day, it opens a dispute without bond.
    pub fn escalate_missing_proof(ctx: Context<EscalateMissingProof>) -> Result<()> {
        instructions::escalate_missing_proof::handler(ctx)
    }

    /// Permissionless: pays out a `Resolved` dispute. The agent-side amount goes through the same
    /// payee resolution and proof gate as `finalize_payment` (no keeper fee); the bond is slashed to
    /// the agent side (FavorAgent) or returned to the institution. Closes the vaults.
    pub fn execute_resolution(ctx: Context<ExecuteResolution>) -> Result<()> {
        instructions::execute_resolution::handler(ctx)
    }

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
        instructions::finalize_payment::handler(ctx)
    }

    /// Flow step 3b: locks `amount` in the vault. Both parties need a fresh, clear screening record.
    /// CCTP (DRAFT M6, BC-36): runs in the same tx after the CCTP `receive_message` that mints USDC to
    /// the institution's token account; no separate instruction is planned.
    pub fn fund_job(ctx: Context<FundJob>) -> Result<()> {
        instructions::fund_job::handler(ctx)
    }

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
        instructions::init_config::handler(
            ctx,
            settlement_mint,
            arbitrators,
            threshold,
            params,
            linked,
        )
    }

    /// Permissionless at or after `dispute.deadline` without a decision. Returns the bond and drops
    /// the dispute: the job goes back to `Delivered` and settles through `finalize_payment`.
    pub fn lapse_dispute(ctx: Context<LapseDispute>) -> Result<()> {
        instructions::lapse_dispute::handler(ctx)
    }

    /// The agent lists its receivable on a delivered job below face value.
    pub fn list_claim(ctx: Context<ListClaim>, price: u64) -> Result<()> {
        instructions::list_claim::handler(ctx, price)
    }

    /// The institution disputes a delivery inside the challenge window with a bond
    /// `>= max(amount * min_bond_bps / 10_000, min_bond_absolute)`. One dispute per job.
    pub fn raise_dispute(
        ctx: Context<RaiseDispute>,
        reason_hash: [u8; 32],
        bond: u64,
    ) -> Result<()> {
        instructions::raise_dispute::handler(ctx, reason_hash, bond)
    }

    /// One arbitrator vote. The first vote sets the pending resolution, later votes must match it;
    /// reaching the threshold moves the job to `Resolved` (`DisputeDecided`). No funds move here.
    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        resolution: DisputeResolution,
    ) -> Result<()> {
        instructions::resolve_dispute::handler(ctx, resolution)
    }

    /// Flow step 4: delivery; the challenge window opens (`challenge_end = now + challenge_period`).
    pub fn submit_work(
        ctx: Context<AgentJob>,
        work_hash: [u8; 32],
        delivery_uri: String,
    ) -> Result<()> {
        instructions::submit_work::handler(ctx, work_hash, delivery_uri)
    }

    /// The agent record owner re-points an unsettled job to the record's current wallet (after a
    /// wallet rotation with registry `update_agent`). A sold receivable keeps paying the buyer.
    pub fn sync_agent_wallet(ctx: Context<SyncAgentWallet>) -> Result<()> {
        instructions::sync_agent_wallet::handler(ctx)
    }

    /// Replaces the arbitrator set (N <= 7, 2 <= M <= N) and bumps `arbitrator_set_version`. An
    /// active dispute keeps its deadline; its next vote restarts the tally with the new set.
    pub fn update_arbitrators(
        ctx: Context<UpdateConfig>,
        arbitrators: Vec<Pubkey>,
        threshold: u8,
    ) -> Result<()> {
        instructions::update_arbitrators::handler(ctx, arbitrators, threshold)
    }

    /// Updates challenge bounds, bond, keeper fee, proof and dispute timeouts and the Travel Rule
    /// threshold.
    pub fn update_params(ctx: Context<UpdateConfig>, params: EscrowParams) -> Result<()> {
        instructions::update_params::handler(ctx, params)
    }
}
