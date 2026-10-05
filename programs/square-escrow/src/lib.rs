//! Square escrow programı (program arayüzü §6, §10.4). Covenant'ın escrow'undan geçmişiyle taşındı (BC-04)
//! ve sözleşmeye göre yeniden yazılıyor. BC-22: config, iş yaşam döngüsü ve agent bağlama. BC-23, BC-24,
//! BC-26: permissionless finalize, keeper ücreti, ispat kapısı, itibar ve validation kaydı. BC-25: alacak
//! piyasası ve alıcı uygunluğu.
//!
//!   Open -(fund_job)-> Funded -(accept_job)-> Accepted -(submit_work)-> Delivered
//!   Delivered -(finalize_payment)-> Released | Refunded
//!   Open | Funded | Accepted (deadline sonrası) -(cancel_job)-> Cancelled
//!
//!   Alacak (Delivered iş): -(list_claim)-> Listed -(buy_claim)-> Bought
//!   Listed -(cancel_claim)-> kapanır; finalize: Listed | Bought -> Settled (ödeme) | Defaulted (iade)
//!
//! İş bir registry `AgentRecord`'una ve opsiyonel bir policy'ye bağlanır; policy'nin commitment'ı, günlük
//! tavanı ve sürümü job'a kopyalanır. Diğer programların hesapları CPI'sız okunur (`linked`,
//! `release_gate`); tek CPI verifier'ın `record_release`'idir. Dispute (BC-32, BC-33) ve Travel Rule
//! commitment'ı (BC-34) kendi issue'larında eklenir.
use anchor_lang::prelude::*;

pub mod config_rules;
pub mod errors;
pub mod instructions;
pub mod linked;
pub mod release_gate;
pub mod state;

use instructions::*;
pub use state::{DisputeResolution, EscrowParams, LinkedPrograms, ValidationOutcome};

// Kaynak programın (Covenant) adresi; Square'in program kimlikleri BC-09'da.
declare_id!("5hstj5grBUL1BeSaPLYpgkD6n3ALasmbseRvKRFfCVNT");

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

    /// The agent lists its receivable on a delivered job below face value.
    pub fn list_claim(ctx: Context<ListClaim>, price: u64) -> Result<()> {
        instructions::list_claim::handler(ctx, price)
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

    /// Updates challenge bounds, bond, keeper fee and the M5 draft parameters.
    pub fn update_params(ctx: Context<UpdateConfig>, params: EscrowParams) -> Result<()> {
        instructions::update_params::handler(ctx, params)
    }
}
