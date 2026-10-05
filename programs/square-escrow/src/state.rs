//! square_escrow hesapları ve tipleri (program arayüzü §5, §10.4). Düzen kuralı: sabit boyutlu alanlar
//! önce, değişken boyutlu alanlar (Option, veri taşıyan enum, String) sonda; indexer ve keeper sabit
//! önekte `memcmp` ile filtreler.

use anchor_lang::prelude::*;

/// Arbitrator setinin üst sınırı (M-of-N, BC-32); onay bit maskesi `u8`.
pub const MAX_ARBITRATORS: usize = 7;
/// Teslimat URI'sinin üst sınırı (bayt; Covenant ve `@squaresdk/solana-types` ile aynı).
pub const DELIVERY_URI_MAX_LEN: usize = 128;
/// Keeper ücretinin üst sınırı: escrow tutarının %1'i (ADR 0013).
pub const MAX_KEEPER_FEE_BPS: u16 = 100;

/// Singleton. seeds = ["config"]
#[account]
#[derive(InitSpace)]
pub struct EscrowConfig {
    pub admin: Pubkey,
    /// The only mint jobs can use (USDC). Policy ceilings and the daily counter are in its units.
    pub settlement_mint: Pubkey,
    /// Owner of `AgentRecord` / `ScreeningRecord` accounts read by escrow.
    pub registry_program: Pubkey,
    /// Owner of `Institution` / `Policy` accounts read by escrow.
    pub policy_program: Pubkey,
    /// Owner of `ReleaseProof`; target of the `record_release` CPI.
    pub verifier_program: Pubkey,
    pub arbitrators: [Pubkey; MAX_ARBITRATORS],
    /// Active slots `arbitrators[..arbitrator_count]` (N).
    pub arbitrator_count: u8,
    /// Approvals required (M), 2 <= M <= N.
    pub threshold: u8,
    /// Bumped on every `update_arbitrators`; disputes snapshot it.
    pub arbitrator_set_version: u32,
    pub params: EscrowParams,
    pub bump: u8,
}

/// seeds = ["job", institution, spec_hash]; vault = ["escrow_token", job], bond vault = ["bond", job]
/// (token authority of both = job).
#[account]
#[derive(InitSpace)]
pub struct Job {
    /// Institution wallet or Squads vault that created/funds the job; refund target.
    pub institution: Pubkey,
    /// square_registry `AgentRecord` the job is bound to; reputation is written against it.
    pub agent_record: Pubkey,
    /// `AgentRecord.wallet` at creation (or at the last `sync_agent_wallet`); signs accept/submit/list
    /// and is the payee unless the receivable was sold.
    pub agent_wallet: Pubkey,
    pub mint: Pubkey,
    /// Paid the rent of the job and its vaults; receives it back when they close.
    pub rent_payer: Pubkey,
    pub amount: u64,
    /// SHA-256 of the off-chain job spec JSON (A2A task mapping, BE side).
    pub spec_hash: [u8; 32],
    pub status: JobStatus,
    pub created_at: i64,
    pub funded_at: i64,
    /// Deadline for delivery.
    pub deadline: i64,
    pub challenge_period: u64,
    /// Set in `submit_work`; finalize allowed after it.
    pub challenge_end: i64,
    pub delivered_at: i64,
    pub settled_at: i64,
    pub work_hash: [u8; 32],
    /// DRAFT (M5): salted Travel Rule commitment; all zeros = none.
    pub travel_rule_commitment: [u8; 32],
    /// Policy snapshot taken at `create_job` (zeros when `policy` is None). The release proof is
    /// checked against it, so later policy updates or deactivation cannot change this job's rules.
    pub policy_commitment: [u8; 32],
    pub policy_daily_ceiling: u64,
    pub policy_version: u32,
    pub bump: u8,
    pub vault_bump: u8,
    /// Set by `raise_dispute`; 0 while no bond vault exists.
    pub bond_bump: u8,
    /// square_policy `Policy`; `Some` = proof-gated release.
    pub policy: Option<Pubkey>,
    pub dispute: DisputeInfo,
    #[max_len(DELIVERY_URI_MAX_LEN)]
    pub delivery_uri: String,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum JobStatus {
    Open,
    Funded,
    Accepted,
    Delivered,
    Disputed,
    /// Arbitrators reached the threshold; `execute_resolution` pays out.
    Resolved,
    /// Agent side was paid (finalize, FavorAgent or Split).
    Released,
    /// Escrow returned to the institution (refused proof or FavorInstitution).
    Refunded,
    Cancelled,
}

/// Inline dispute state; `raised_at == 0` means no dispute. One dispute per job.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace,
)]
pub struct DisputeInfo {
    /// Institution (`raise_dispute`) or agent wallet (`escalate_missing_proof`, DRAFT).
    pub challenger: Pubkey,
    /// 0 for an escalation without bond.
    pub bond: u64,
    pub reason_hash: [u8; 32],
    pub raised_at: i64,
    /// DRAFT (M5): `raised_at + dispute_timeout_secs`; `lapse_dispute` allowed after it.
    pub deadline: i64,
    /// When the threshold was reached.
    pub decided_at: i64,
    /// When `execute_resolution` or `lapse_dispute` closed the dispute.
    pub closed_at: i64,
    pub lapsed: bool,
    /// Bit i = `config.arbitrators[i]` voted for `resolution`.
    pub approval_mask: u8,
    pub approval_count: u8,
    /// `config.arbitrator_set_version` when the dispute was raised.
    pub arbitrator_set_version: u32,
    pub resolution: DisputeResolution,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace,
)]
pub enum DisputeResolution {
    #[default]
    Pending,
    /// Agent side (payee) gets the escrow; a bond is slashed to the agent side.
    FavorAgent,
    /// Escrow refunded to the institution; a bond is returned.
    FavorInstitution,
    /// Agent side gets `agent_amount`, rest refunded; a bond is returned.
    Split { agent_amount: u64 },
}

/// seeds = ["claim", job]
#[account]
#[derive(InitSpace)]
pub struct ClaimListing {
    pub job: Pubkey,
    /// `job.agent_wallet` at listing time.
    pub seller: Pubkey,
    /// `Pubkey::default()` until bought.
    pub buyer: Pubkey,
    /// Paid the listing rent; receives it back on `cancel_claim`.
    pub rent_payer: Pubkey,
    pub price: u64,
    /// `job.amount` at listing time (informational).
    pub face_value: u64,
    pub listed_at: i64,
    pub bought_at: i64,
    pub status: ClaimStatus,
    pub bump: u8,
}

/// `cancel_claim` closes the listing, so there is no Cancelled state.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ClaimStatus {
    Listed,
    Bought,
    /// Job settled: the buyer was paid, or an unsold listing was closed for buying.
    Settled,
    /// Job refunded to the institution; the buyer is not paid.
    Defaulted,
}

/// seeds = ["reputation", agent_record] — bound to the registry agent, not to a wallet (BC-26).
#[account]
#[derive(InitSpace)]
pub struct AgentReputation {
    pub agent_record: Pubkey,
    pub jobs_completed: u64,
    pub jobs_failed: u64,
    pub jobs_disputed: u64,
    pub total_earned: u64,
    pub first_job_at: i64,
    pub last_job_at: i64,
    pub bump: u8,
}

/// seeds = ["validation", job] — gate outcome of a settled job (BC-26); written once per job.
#[account]
#[derive(InitSpace)]
pub struct ValidationRecord {
    pub job: Pubkey,
    pub agent_record: Pubkey,
    pub outcome: ValidationOutcome,
    /// `ReleaseProof.refusal_code` when Refused, else 0.
    pub refusal_code: u16,
    pub recorded_at: i64,
    pub bump: u8,
    pub policy: Option<Pubkey>,
    pub release_proof: Option<Pubkey>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ValidationOutcome {
    /// Policy job, compliant proof, agent side paid.
    Verified,
    /// Policy job, refusing proof, escrow refunded.
    Refused,
    /// Job without policy, agent side paid.
    NoGate,
    /// Nothing paid to the agent side (FavorInstitution).
    NoPayout,
}

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

impl JobStatus {
    /// Ödeme ya da iadeyle kapanmış (ya da iptal edilmiş) iş; artık değişmez.
    pub fn is_settled(self) -> bool {
        matches!(self, Self::Released | Self::Refunded | Self::Cancelled)
    }
}
